import { execFileSync } from "node:child_process";
import { dirname, relative } from "node:path";
import { resolveRepositoryPath } from "./roots.ts";

export function codeAddress(address: string): { path: string; symbol?: string } {
  const hash = address.indexOf("#");
  return hash < 0 ? { path: address } : { path: address.slice(0, hash), symbol: address.slice(hash + 1) };
}
export function repositoryHead(address: string): { root: string; commit: string } | undefined {
  try {
    const root = execFileSync("git", ["-C", dirname(codeAddress(address).path), "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { root, commit };
  } catch { return undefined; }
}
export function committedText(root: string, commit: string, address: string): string | undefined {
  try { return execFileSync("git", ["-C", root, "show", `${commit}:${relative(root, codeAddress(address).path)}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return undefined; }
}

interface Token { text: string; start: number; end: number }
/** Lexical declaration boundaries without a runtime parser. */
function tokens(source: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  // shortcut: regexes after control-flow heads and TSX need grammar context; use a parser if these must be supported.
  let expectsExpression = true;
  const quoted = (quote: string) => {
    at++;
    while (at < source.length) {
      const c = source[at++]!;
      if (c === "\\") at++;
      else if (c === quote) break;
      else if (quote === "`" && c === "$" && source[at] === "{") {
        at++;
        let depth = 1;
        while (at < source.length && depth) {
          const c = source[at]!;
          if (c === "\"" || c === "'" || c === "`") quoted(c);
          else if (source.startsWith("//", at)) { while (at < source.length && source[at] !== "\n") at++; }
          else if (source.startsWith("/*", at)) { const end = source.indexOf("*/", at + 2); at = end < 0 ? source.length : end + 2; }
          else { at++; if (c === "{") depth++; else if (c === "}") depth--; }
        }
      }
    }
  };
  while (at < source.length) {
    const c = source[at]!;
    if (/\s/.test(c)) { at++; continue; }
    if (source.startsWith("//", at)) { while (at < source.length && source[at] !== "\n") at++; continue; }
    if (source.startsWith("/*", at)) { const end = source.indexOf("*/", at + 2); at = end < 0 ? source.length : end + 2; continue; }
    const start = at;
    if (c === "\"" || c === "'" || c === "`") { quoted(c); out.push({ text: "literal", start, end: at }); expectsExpression = false; continue; }
    if (c === "/" && expectsExpression) {
      at++;
      let bracket = false;
      while (at < source.length) {
        const c = source[at++]!;
        if (c === "\\") at++;
        else if (c === "[") bracket = true;
        else if (c === "]") bracket = false;
        else if (c === "/" && !bracket) break;
      }
      while (/[a-z]/i.test(source[at] ?? "") && at < source.length) at++;
      out.push({ text: "literal", start, end: at }); expectsExpression = false; continue;
    }
    if (/[\w$]/.test(c)) { while (at < source.length && /[\w$]/.test(source[at]!)) at++; }
    else at += source.startsWith("=>", at) || source.startsWith("++", at) || source.startsWith("--", at) ? 2 : 1;
    const text = source.slice(start, at);
    // Unary ! still expects its operand; postfix ! still follows a complete expression.
    if (!["!", "++", "--"].includes(text))
      expectsExpression = /^[\w$]/.test(text) ? /^(?:return|throw|case|delete|void|typeof|new|in|of|yield|await|instanceof)$/.test(text)
        : ![")", "]", "}", "."].includes(text);
    out.push({ text, start, end: at });
  }
  return out;
}

/** Declaration-line lookup followed by balanced delimiters; no TypeScript runtime dependency. */
export function symbolText(source: string | undefined, symbol: string): string | undefined {
  if (source === undefined) return undefined;
  const qualified = /^([\w$]+)\.(.+)$/.exec(symbol);
  if (qualified) return symbolText(symbolText(source, qualified[1]!), qualified[2]!);
  if (!/^(?:[\w$]+|#[\w$]+|\[Symbol\.[\w$]+\])$/.test(symbol)) return undefined;
  const lex = tokens(source), name = tokens(symbol);
  const close = (open: number, left: string, right: string) => {
    let depth = 0;
    for (let i = open; i < lex.length; i++) {
      if (lex[i]!.text === left) depth++;
      if (lex[i]!.text === right && --depth === 0) return i;
    }
    return -1;
  };
  const candidates: { i: number; depth: number }[] = [];
  let depth = 0;
  for (let i = 0; i < lex.length; i++) {
    if (name.every((part, offset) => lex[i + offset]?.text === part.text)) candidates.push({ i, depth });
    if (lex[i]!.text === "{") depth++;
    else if (lex[i]!.text === "}") depth--;
  }
  candidates.sort((a, b) => a.depth - b.depth);
  let found: string | undefined, foundDepth = Infinity;
  for (const { i, depth } of candidates) {
    if (depth > foundDepth) break;
    const line = source.lastIndexOf("\n", lex[i]!.start - 1) + 1;
    const prefix = source.slice(line, lex[i]!.start);
    const declaration = /^\s*(?:(?:export|default|declare|async|abstract|public|private|protected|static|override|readonly)\s+)*(?:(function\s*\*?\s*)|(class\s+)|(const\s+)|(get\s+|set\s+))?$/.exec(prefix);
    if (!declaration) continue;
    const start = line + prefix.search(/\S|$/);
    let body = i + name.length;
    if (symbol === "default" && lex[body]?.text === "function" && lex[body + 1]?.text === "(") body++;
    if (declaration[3]) {
      // A variable link names an arrow function, not an arbitrary initializer.
      // Type annotations may contain their own arrows; only inspect the initializer.
      while (body < lex.length && !["=", ";"].includes(lex[body]!.text)) {
        const pair = { "(": ")", "[": "]", "{": "}", "<": ">" }[lex[body]!.text];
        if (pair) { const end = close(body, lex[body]!.text, pair); if (end < 0) break; body = end; }
        body++;
      }
      if (lex[body]?.text !== "=") continue;
      body++;
      while (body < lex.length && !["=>", ";"].includes(lex[body]!.text)) {
        const pair = { "(": ")", "[": "]", "{": "}", "<": ">" }[lex[body]!.text];
        if (pair) { const end = close(body, lex[body]!.text, pair); if (end < 0) break; body = end; }
        body++;
      }
      if (lex[body]?.text !== "=>") continue;
      body++;
      if (lex[body]?.text !== "{") {
        let end = body;
        while (end < lex.length && ![";", "}"].includes(lex[end]!.text)) {
          const token = lex[end]!, previous = lex[end - 1]!;
          if (end > body && /[\r\n\u2028\u2029]/.test(source.slice(previous.end, token.start))) {
            const complete = /^(?:[\w$]+|[)\]}!]|\+\+|--)$/.test(previous.text) &&
              !/^(?:await|yield|new|delete|void|typeof|in|instanceof|as|satisfies)$/.test(previous.text);
            const continues = /^(?:[([.?:+\-*/%<>=&|^]|in|instanceof|as|satisfies)$/.test(token.text) ||
              token.text === "!" && lex[end + 1]?.text === "=" || source[token.start] === "`";
            if (complete && !continues) break;
          }
          if (["(", "[", "{"].includes(lex[end]!.text)) {
            const paired = close(end, lex[end]!.text, { "(": ")", "[": "]", "{": "}" }[lex[end]!.text]!);
            if (paired < 0) break;
            end = paired;
          }
          end++;
        }
        if (found !== undefined) return undefined;
        found = source.slice(lex[i]!.start, lex[end - 1]?.end); foundDepth = depth;
        continue;
      }
    } else if (!declaration[2]) {
      if (lex[body]?.text === "<") { const end = close(body, "<", ">"); if (end < 0) continue; body = end + 1; }
      if (lex[body]?.text !== "(") continue;
      const end = close(body, "(", ")");
      if (end < 0) continue;
      body = end + 1;
      if (!["{", ":", ";"].includes(lex[body]?.text ?? "")) continue;
      if (lex[body]?.text === ":") {
        body++;
        let expectsType = true;
        while (body < lex.length) {
          const text = lex[body]!.text;
          if (text === "{" && !expectsType || text === ";") break;
          const pair = { "(": ")", "[": "]", "<": ">", "{": "}" }[text];
          if (pair) {
            const end = close(body, text, pair);
            if (end < 0) break;
            body = end + 1;
            expectsType = false;
          } else {
            expectsType = ["|", "&", "=>"].includes(text);
            body++;
          }
        }
      }
    }
    while (body < lex.length && !["{", ";"].includes(lex[body]!.text)) {
      // Constraints and extends expressions can contain braces before the class body.
      const pair = declaration[2] && { "<": ">", "(": ")", "[": "]" }[lex[body]!.text];
      if (pair) { const end = close(body, lex[body]!.text, pair); if (end < 0) break; body = end; }
      body++;
    }
    if (lex[body]?.text !== "{") continue;
    const end = close(body, "{", "}");
    if (end >= 0) {
      if (found !== undefined) return undefined;
      found = source.slice(declaration[3] ? lex[i]!.start : start, lex[end]!.end); foundDepth = depth;
    }
  }
  return found;
}

export function resolveCodeLink(address: string, roots: readonly string[], heads?: Map<string, string>): { path: string } | { reason: string } {
  const link = codeAddress(address), resolved = resolveRepositoryPath(link.path, roots);
  if ("reason" in resolved) return resolved;
  const repo = link.symbol !== undefined || heads ? repositoryHead(resolved.path) : undefined;
  if (repo && heads && !heads.has(repo.root)) heads.set(repo.root, repo.commit);
  if (link.symbol === undefined) return resolved;
  if (!repo || symbolText(committedText(repo.root, repo.commit, resolved.path), link.symbol) === undefined)
    return { reason: `${address}: symbol missing at HEAD (or ambiguous; use Class.method)` };
  return { path: `${resolved.path}#${link.symbol}` };
}
