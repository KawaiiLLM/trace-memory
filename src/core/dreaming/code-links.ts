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
/** Only lexical boundaries: comments, strings, templates and regexes cannot close a declaration's braces. */
function tokens(source: string): Token[] {
  const out: Token[] = [];
  let at = 0;
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
    if (c === "\"" || c === "'" || c === "`") { quoted(c); out.push({ text: "literal", start, end: at }); continue; }
    const previous = out.at(-1)?.text;
    if (c === "/" && (!previous || /^(?:[=(:,&|?;{\[]|return|throw|case|=>)$/.test(previous) ||
      previous === "!" && !/^[\w$)\]]+$/.test(out.at(-2)?.text ?? ""))) {
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
      out.push({ text: "literal", start, end: at }); continue;
    }
    if (/[\w$]/.test(c)) { while (at < source.length && /[\w$]/.test(source[at]!)) at++; }
    else at += source.startsWith("=>", at) ? 2 : 1;
    out.push({ text: source.slice(start, at), start, end: at });
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
      while (body < lex.length && !["=>", ";"].includes(lex[body]!.text)) {
        const pair = { "(": ")", "[": "]", "{": "}", "<": ">" }[lex[body]!.text];
        if (pair) { const end = close(body, lex[body]!.text, pair); if (end < 0) break; body = end; }
        body++;
      }
      if (lex[body]?.text !== "=>") continue;
      body++;
      if (lex[body]?.text !== "{") {
        let end = body;
        while (end < lex.length && lex[end]!.text !== ";") {
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
    while (body < lex.length && !["{", ";"].includes(lex[body]!.text)) body++;
    if (lex[body]?.text !== "{") continue;
    const end = close(body, "{", "}");
    if (end >= 0) {
      if (found !== undefined) return undefined;
      found = source.slice(declaration[3] ? lex[i]!.start : start, lex[end]!.end); foundDepth = depth;
    }
  }
  return found;
}

export function resolveCodeLink(address: string, roots: readonly string[]): { path: string } | { reason: string } {
  const link = codeAddress(address), resolved = resolveRepositoryPath(link.path, roots);
  if ("reason" in resolved) return resolved;
  if (link.symbol === undefined) return resolved;
  const repo = repositoryHead(resolved.path);
  if (!repo || symbolText(committedText(repo.root, repo.commit, resolved.path), link.symbol) === undefined)
    return { reason: `${address}: symbol missing at HEAD (or ambiguous; use Class.method)` };
  return { path: `${resolved.path}#${link.symbol}` };
}
