// src/openai/utils.ts

// IMPORTANT: Only strip a fence if the entire response is a single fenced block.
// This prevents accidentally stripping code fences that appear inside <diff>.
export function stripFirstMarkdownFence(s: string): string {
  const t = String(s ?? "");
  const m = t.match(/^\s*```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return m ? m[1] : t;
}

export function stripCData(s: string): string {
  const t = String(s ?? "");
  const m = t.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : t;
}

// Kept for backward compatibility (may be used elsewhere)
export function escapeRegExp(s: string): string {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i])) i++;
  return i;
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

function matchCDataAt(s: string, i: number): { end: number } | null {
  if (!s.startsWith("<![CDATA[", i)) return null;
  const end = s.indexOf("]]>", i + "<![CDATA[".length);
  if (end < 0) return { end: s.length };
  return { end: end + 3 };
}

// We intentionally disallow attributes in tags: we only accept <tag> and </tag>.
// This makes parsing deterministic and keeps the output “machine format” simple.
function matchOpenTagAt(s: string, i: number, tagLower: string): { start: number; end: number } | null {
  if (s[i] !== "<") return null;
  let j = i + 1;
  j = skipWs(s, j);
  if (j >= s.length) return null;
  if (s[j] === "/") return null;

  const nameStart = j;
  while (j < s.length && isNameChar(s[j])) j++;
  if (j === nameStart) return null;

  const name = s.slice(nameStart, j).toLowerCase();
  if (name !== tagLower) return null;

  j = skipWs(s, j);
  if (s[j] === ">") return { start: i, end: j + 1 };

  return null;
}

function matchCloseTagAt(s: string, i: number, tagLower: string): { start: number; end: number } | null {
  if (s[i] !== "<") return null;
  let j = i + 1;
  j = skipWs(s, j);
  if (j >= s.length) return null;
  if (s[j] !== "/") return null;

  j++;
  j = skipWs(s, j);

  const nameStart = j;
  while (j < s.length && isNameChar(s[j])) j++;
  if (j === nameStart) return null;

  const name = s.slice(nameStart, j).toLowerCase();
  if (name !== tagLower) return null;

  j = skipWs(s, j);
  if (s[j] === ">") return { start: i, end: j + 1 };

  return null;
}

export type TagBlock = {
  tag: string;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  inner: string;
};

function extractTagBlockStartingAt(s: string, start: number, tag: string): TagBlock | null {
  const tagLower = tag.toLowerCase();
  const open = matchOpenTagAt(s, start, tagLower);
  if (!open) return null;

  const innerStart = open.end;
  let pos = innerStart;
  let depth = 1;

  while (pos < s.length) {
    const lt = s.indexOf("<", pos);
    if (lt < 0) break;

    const cdata = matchCDataAt(s, lt);
    if (cdata) {
      pos = cdata.end;
      continue;
    }

    const open2 = matchOpenTagAt(s, lt, tagLower);
    if (open2) {
      depth++;
      pos = open2.end;
      continue;
    }

    const close = matchCloseTagAt(s, lt, tagLower);
    if (close) {
      depth--;
      if (depth === 0) {
        const innerEnd = close.start;
        return {
          tag,
          start: open.start,
          end: close.end,
          innerStart,
          innerEnd,
          inner: s.slice(innerStart, innerEnd)
        };
      }
      pos = close.end;
      continue;
    }

    pos = lt + 1;
  }

  return null;
}

function findNextOpenTag(s: string, from: number, tag: string): number {
  const tagLower = tag.toLowerCase();
  let pos = from;

  while (pos < s.length) {
    const lt = s.indexOf("<", pos);
    if (lt < 0) return -1;

    const cdata = matchCDataAt(s, lt);
    if (cdata) {
      pos = cdata.end;
      continue;
    }

    const open = matchOpenTagAt(s, lt, tagLower);
    if (open) return open.start;

    pos = lt + 1;
  }

  return -1;
}

export function extractTagValue(raw: string, tag: string): string | null {
  const t = stripFirstMarkdownFence(String(raw ?? ""));
  const start = findNextOpenTag(t, 0, tag);
  if (start < 0) return null;
  const block = extractTagBlockStartingAt(t, start, tag);
  return block ? block.inner : null;
}

export function extractAllTagValues(raw: string, tag: string): string[] {
  const t = stripFirstMarkdownFence(String(raw ?? ""));
  const out: string[] = [];
  let pos = 0;

  while (pos < t.length) {
    const start = findNextOpenTag(t, pos, tag);
    if (start < 0) break;
    const block = extractTagBlockStartingAt(t, start, tag);
    if (!block) break;
    out.push(block.inner);
    pos = block.end;
  }

  return out;
}

/**
 * Enforce: the text contains ONLY the specified tags, in EXACT order,
 * with only whitespace allowed between them.
 */
export function assertOnlyTagsInOrder(raw: string, tags: readonly string[]): void {
  const t = stripFirstMarkdownFence(String(raw ?? "")).trim();
  let pos = 0;

  for (const tag of tags) {
    pos = skipWs(t, pos);

    const open = matchOpenTagAt(t, pos, tag.toLowerCase());
    if (!open) {
      const snippet = t.slice(pos, Math.min(t.length, pos + 80));
      throw new Error(`Expected <${tag}> at position ${pos}. Found: ${JSON.stringify(snippet)}`);
    }

    const block = extractTagBlockStartingAt(t, pos, tag);
    if (!block) {
      throw new Error(`Malformed <${tag}>...</${tag}> block (missing close tag or bad nesting).`);
    }

    pos = block.end;
  }

  pos = skipWs(t, pos);
  if (pos !== t.length) {
    const tail = t.slice(pos, Math.min(t.length, pos + 120));
    throw new Error(`Output contains extra text after last tag: ${JSON.stringify(tail)}`);
  }
}

export function parseTaggedObjectStrict<T extends Record<string, string>>(
  raw: string,
  schemaKeys: readonly (keyof T & string)[],
  opts?: { enforceOnlyTags?: boolean }
): T {
  const keys = schemaKeys as readonly string[];

  if (opts?.enforceOnlyTags) {
    assertOnlyTagsInOrder(raw, keys);
  }

  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = extractTagValue(raw, k);
    if (v == null) throw new Error(`Missing required tag <${k}>...</${k}> in model output.`);
    out[k] = stripCData(v).trim();
  }
  return out as T;
}

// ------------------------------
// General nested schema support
// ------------------------------

export type TaggedStringSchema = {
  kind: "string";
  tag?: string;
  required?: boolean;
  trim?: boolean;   // default true
  cdata?: boolean;  // just a hint for instruction rendering
};

export type TaggedNumberSchema = {
  kind: "number";
  tag?: string;
  required?: boolean;
};

export type TaggedBooleanSchema = {
  kind: "boolean";
  tag?: string;
  required?: boolean;
};

export type TaggedArraySchema<TItem> = {
  kind: "array";
  tag?: string;         // container tag (defaults to property name when used as a field)
  itemTag: string;      // e.g. "edit"
  item: TaggedSchema<TItem>;
  required?: boolean;
  minItems?: number;
  maxItems?: number;
  enforceOnlyItems?: boolean; // container can contain only <itemTag> blocks + whitespace
};

export type TaggedObjectSchema<T extends object> = {
  kind: "object";
  tag?: string; // wrapper tag; typically omitted for root and for array items
  fields: { [K in keyof T]-?: TaggedSchema<T[K]> };
  order?: readonly (keyof T & string)[];
  required?: boolean;
  enforceOnlyTags?: boolean; // enforce order + no extra text at this object level
};

export type TaggedSchema<T> =
  | TaggedStringSchema
  | TaggedNumberSchema
  | TaggedBooleanSchema
  | TaggedArraySchema<any>
  | TaggedObjectSchema<any>;

const MISSING = Symbol("TAGGED_SCHEMA_MISSING");

type ParseOpts = { enforceOnlyTags?: boolean };

function parseNumberStrict(s: string, path: string): number {
  const t = s.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(t)) {
    throw new Error(`Expected a number at ${path}, got: ${JSON.stringify(s)}`);
  }
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`Expected a finite number at ${path}, got: ${JSON.stringify(s)}`);
  return n;
}

function parseBooleanStrict(s: string, path: string): boolean {
  const t = s.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  throw new Error(`Expected 'true' or 'false' at ${path}, got: ${JSON.stringify(s)}`);
}

function assertOnlyRepeatedTagBlocks(container: string, itemTag: string): void {
  const t = container.trim();
  if (!t) return;

  let pos = 0;
  while (pos < t.length) {
    while (pos < t.length && isWs(t[pos])) pos++;
    if (pos >= t.length) return;

    const openOk = matchOpenTagAt(t, pos, itemTag.toLowerCase());
    if (!openOk) {
      const snippet = t.slice(pos, Math.min(t.length, pos + 80));
      throw new Error(`Expected <${itemTag}> block in array container. Found: ${JSON.stringify(snippet)}`);
    }

    const block = extractTagBlockStartingAt(t, pos, itemTag);
    if (!block) throw new Error(`Malformed <${itemTag}>...</${itemTag}> block inside array container.`);
    pos = block.end;
  }
}

function parseNode(
  text: string,
  schema: TaggedSchema<any>,
  path: string,
  impliedTag?: string,
  opts?: ParseOpts
): any {
  const kind = (schema as any).kind as TaggedSchema<any>["kind"];
  const required = (schema as any).required !== false; // default true
  const tag = impliedTag ?? (schema as any).tag;

  let inner: string;
  if (tag) {
    const v = extractTagValue(text, tag);
    if (v == null) {
      if (required) throw new Error(`Missing required tag <${tag}> at ${path}.`);
      return MISSING;
    }
    inner = v;
  } else {
    inner = text;
  }

  const innerNoCdata = stripCData(inner);

  if (kind === "string") {
    const trim = (schema as TaggedStringSchema).trim !== false;
    return trim ? innerNoCdata.trim() : innerNoCdata;
  }

  if (kind === "number") {
    return parseNumberStrict(innerNoCdata, path);
  }

  if (kind === "boolean") {
    return parseBooleanStrict(innerNoCdata, path);
  }

  if (kind === "array") {
    const arrSchema = schema as TaggedArraySchema<any>;
    const itemTag = arrSchema.itemTag;
    const containerText = innerNoCdata;

    if (arrSchema.enforceOnlyItems) {
      assertOnlyRepeatedTagBlocks(containerText, itemTag);
    }

    const itemsRaw = extractAllTagValues(containerText, itemTag);
    const items = itemsRaw.map((itemInner, i) =>
      parseNode(itemInner, arrSchema.item, `${path}[${i}]`, undefined, opts)
    );

    if (arrSchema.minItems != null && items.length < arrSchema.minItems) {
      throw new Error(`Expected at least ${arrSchema.minItems} <${itemTag}> items at ${path}, got ${items.length}.`);
    }
    if (arrSchema.maxItems != null && items.length > arrSchema.maxItems) {
      throw new Error(`Expected at most ${arrSchema.maxItems} <${itemTag}> items at ${path}, got ${items.length}.`);
    }

    return items;
  }

  if (kind === "object") {
    const objSchema = schema as TaggedObjectSchema<any>;
    const objText = innerNoCdata;

    const keys = (objSchema.order ??
      (Object.keys(objSchema.fields) as string[])) as readonly string[];

    const tagsInOrder = keys.map((k) => {
      const child = (objSchema.fields as any)[k] as TaggedSchema<any> | undefined;
      const childTag = (child as any)?.tag ?? k;
      return String(childTag);
    });

    const enforce = objSchema.enforceOnlyTags ?? opts?.enforceOnlyTags ?? false;
    if (enforce) {
      assertOnlyTagsInOrder(objText, tagsInOrder);
    }

    const out: Record<string, any> = {};
    for (const k of keys) {
      const childSchema = (objSchema.fields as any)[k] as TaggedSchema<any> | undefined;
      if (!childSchema) continue;

      const childTag = (childSchema as any).tag ?? k;
      const val = parseNode(objText, childSchema, path ? `${path}.${k}` : k, String(childTag), opts);
      if (val !== MISSING) out[k] = val;
    }

    return out;
  }

  throw new Error(`Unknown schema kind ${(schema as any).kind} at ${path}.`);
}

export function parseTaggedBySchema<T>(raw: string, schema: TaggedSchema<T>, opts?: ParseOpts): T {
  const t = stripFirstMarkdownFence(String(raw ?? ""));
  const val = parseNode(t, schema, "<root>", undefined, opts);
  if (val === MISSING) throw new Error("Root value missing (schema marked optional?)");
  return val as T;
}
