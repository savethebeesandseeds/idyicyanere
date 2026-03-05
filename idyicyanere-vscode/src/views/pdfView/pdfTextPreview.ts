import * as zlib from "zlib";

export type PdfTextPreview = {
  pages: string[];
  warnings: string[];
};

type PdfRef = { num: number; gen: number };

type PdfObject = {
  ref: PdfRef;
  body: string;
  dict: string;
  stream?: Buffer;
};

function refKey(ref: PdfRef): string {
  return `${ref.num} ${ref.gen}`;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\v";
}

function isDelimiter(ch: string): boolean {
  return (
    isWhitespace(ch) ||
    ch === "[" ||
    ch === "]" ||
    ch === "(" ||
    ch === ")" ||
    ch === "<" ||
    ch === ">" ||
    ch === "{" ||
    ch === "}" ||
    ch === "/" ||
    ch === "%"
  );
}

function parseRefs(text: string): PdfRef[] {
  const refs: PdfRef[] = [];
  const re = /(\d+)\s+(\d+)\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.push({ num: Number(m[1]), gen: Number(m[2]) });
  }
  return refs;
}

function parseObjects(bytes: Uint8Array): Map<string, PdfObject> {
  const out = new Map<string, PdfObject>();
  const text = Buffer.from(bytes).toString("latin1");
  const re = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    const gen = Number(m[2]);
    const body = m[3] ?? "";
    const streamInfo = findStreamSlice(body);

    let dict = body;
    let stream: Buffer | undefined;

    if (streamInfo) {
      dict = body.slice(0, streamInfo.streamKeywordIndex);
      const streamRaw = body.slice(streamInfo.contentStart, streamInfo.contentEnd);
      stream = Buffer.from(streamRaw, "latin1");
    }

    const ref = { num, gen };
    out.set(refKey(ref), { ref, body, dict, stream });
  }

  return out;
}

function findStreamSlice(body: string): {
  streamKeywordIndex: number;
  contentStart: number;
  contentEnd: number;
} | null {
  const streamKeywordIndex = body.indexOf("stream");
  const endstreamIndex = body.lastIndexOf("endstream");
  if (streamKeywordIndex < 0 || endstreamIndex < 0 || endstreamIndex <= streamKeywordIndex) {
    return null;
  }

  let contentStart = streamKeywordIndex + "stream".length;
  if (body[contentStart] === "\r" && body[contentStart + 1] === "\n") {
    contentStart += 2;
  } else if (body[contentStart] === "\n" || body[contentStart] === "\r") {
    contentStart += 1;
  }

  let contentEnd = endstreamIndex;
  while (contentEnd > contentStart && (body[contentEnd - 1] === "\n" || body[contentEnd - 1] === "\r")) {
    contentEnd -= 1;
  }

  return { streamKeywordIndex, contentStart, contentEnd };
}

function parseFilters(dict: string): string[] {
  const normalize = (name: string): string => {
    if (name === "Fl") return "FlateDecode";
    if (name === "AHx") return "ASCIIHexDecode";
    if (name === "A85") return "ASCII85Decode";
    return name;
  };

  const arrayMatch = /\/Filter\s*\[([\s\S]*?)\]/m.exec(dict);
  if (arrayMatch) {
    const names: string[] = [];
    const nameRe = /\/([A-Za-z0-9]+)/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(arrayMatch[1])) !== null) {
      names.push(normalize(m[1]));
    }
    return names;
  }

  const single = /\/Filter\s*\/([A-Za-z0-9]+)/.exec(dict);
  return single ? [normalize(single[1])] : [];
}

function decodeAsciiHex(src: string): Buffer {
  const hex = src.replace(/[^0-9A-Fa-f]/g, "");
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  return Buffer.from(padded, "hex") as Buffer;
}

function decodeAscii85(src: string): Buffer | null {
  const s = src.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>$/, "");
  const out: number[] = [];
  let group: number[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 33 || code > 117) continue;

    group.push(code - 33);
    if (group.length === 5) {
      let value = 0;
      for (const v of group) value = value * 85 + v;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }

  if (group.length > 0) {
    const originalLen = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const v of group) value = value * 85 + v;
    const chunk = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...chunk.slice(0, originalLen - 1));
  }

  return Buffer.from(out) as Buffer;
}

function decodeStream(obj: PdfObject, warnings: string[]): Buffer | null {
  if (!obj.stream) return null;

  const filters = parseFilters(obj.dict);
  let data: Buffer = Buffer.from(obj.stream) as Buffer;
  if (!filters.length) return data;

  for (const f of filters) {
    if (f === "FlateDecode") {
      try {
        data = zlib.inflateSync(data) as Buffer;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`FlateDecode failed on object ${obj.ref.num} ${obj.ref.gen}: ${msg}`);
        return null;
      }
      continue;
    }

    if (f === "ASCIIHexDecode") {
      data = decodeAsciiHex(data.toString("latin1")) as Buffer;
      continue;
    }

    if (f === "ASCII85Decode") {
      const decoded = decodeAscii85(data.toString("latin1"));
      if (!decoded) {
        warnings.push(`ASCII85Decode failed on object ${obj.ref.num} ${obj.ref.gen}.`);
        return null;
      }
      data = decoded as Buffer;
      continue;
    }

    warnings.push(`Unsupported stream filter /${f} on object ${obj.ref.num} ${obj.ref.gen}.`);
    return null;
  }

  return data;
}

function extractTopLevelDict(body: string): string {
  const start = body.indexOf("<<");
  if (start < 0) return body;

  let depth = 0;
  for (let i = start; i < body.length - 1; i++) {
    const c = body[i];
    const n = body[i + 1];
    if (c === "<" && n === "<") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ">" && n === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return body.slice(start, i + 1);
      continue;
    }
  }

  return body;
}

function expandObjectStreams(objects: Map<string, PdfObject>, warnings: string[]): void {
  const baseObjects = Array.from(objects.values());

  for (const obj of baseObjects) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;

    const decoded = decodeStream(obj, warnings);
    if (!decoded) continue;

    const txt = decoded.toString("latin1");
    const nMatch = /\/N\s+(\d+)/.exec(obj.dict);
    const firstMatch = /\/First\s+(\d+)/.exec(obj.dict);
    if (!nMatch || !firstMatch) {
      warnings.push(`ObjStm ${obj.ref.num} ${obj.ref.gen} missing /N or /First.`);
      continue;
    }

    const n = Number(nMatch[1]);
    const first = Number(firstMatch[1]);
    if (!Number.isFinite(n) || !Number.isFinite(first) || n <= 0 || first < 0 || first > txt.length) {
      warnings.push(`ObjStm ${obj.ref.num} ${obj.ref.gen} has invalid /N or /First values.`);
      continue;
    }

    const header = txt.slice(0, first);
    const body = txt.slice(first);
    const nums = (header.match(/-?\d+/g) ?? []).map((v) => Number(v));
    const pairCount = Math.min(n, Math.floor(nums.length / 2));
    if (pairCount < n) {
      warnings.push(
        `ObjStm ${obj.ref.num} ${obj.ref.gen} header shorter than /N (${pairCount}/${n}); using available entries.`
      );
    }
    if (!pairCount) continue;

    const entries: Array<{ objNum: number; offset: number }> = [];
    for (let i = 0; i < pairCount; i++) {
      entries.push({ objNum: nums[i * 2], offset: nums[i * 2 + 1] });
    }
    entries.sort((a, b) => a.offset - b.offset);

    for (let i = 0; i < entries.length; i++) {
      const cur = entries[i];
      const next = entries[i + 1];
      if (cur.offset < 0 || cur.offset > body.length) continue;

      const end = next ? Math.min(next.offset, body.length) : body.length;
      if (end <= cur.offset) continue;

      const rawBody = body.slice(cur.offset, end).trim();
      if (!rawBody) continue;

      const ref: PdfRef = { num: cur.objNum, gen: 0 };
      const key = refKey(ref);
      if (objects.has(key)) continue;

      const streamInfo = findStreamSlice(rawBody);
      let dict = rawBody;
      let stream: Buffer | undefined;

      if (streamInfo) {
        dict = rawBody.slice(0, streamInfo.streamKeywordIndex);
        const rawStream = rawBody.slice(streamInfo.contentStart, streamInfo.contentEnd);
        stream = Buffer.from(rawStream, "latin1") as Buffer;
      } else {
        dict = extractTopLevelDict(rawBody);
      }

      objects.set(key, { ref, body: rawBody, dict, stream });
    }
  }
}

function getPageRefs(objects: Map<string, PdfObject>, warnings: string[]): PdfRef[] {
  const refs: PdfRef[] = [];
  const seen = new Set<string>();

  const catalogs = Array.from(objects.values()).filter((o) => /\/Type\s*\/Catalog\b/.test(o.dict));
  if (catalogs.length > 0) {
    const pagesRefMatch = /\/Pages\s+(\d+)\s+(\d+)\s+R/.exec(catalogs[0].dict);
    if (pagesRefMatch) {
      collectPages(
        { num: Number(pagesRefMatch[1]), gen: Number(pagesRefMatch[2]) },
        objects,
        refs,
        seen,
        warnings
      );
    }
  }

  if (refs.length > 0) return refs;

  const fallback = Array.from(objects.values())
    .filter((o) => /\/Type\s*\/Page(?!s)\b/.test(o.dict))
    .map((o) => o.ref)
    .sort((a, b) => a.num - b.num || a.gen - b.gen);

  return fallback;
}

function collectPages(
  ref: PdfRef,
  objects: Map<string, PdfObject>,
  out: PdfRef[],
  seen: Set<string>,
  warnings: string[]
): void {
  const key = refKey(ref);
  if (seen.has(key)) return;
  seen.add(key);

  const obj = objects.get(key);
  if (!obj) {
    warnings.push(`Missing object ${ref.num} ${ref.gen} while traversing page tree.`);
    return;
  }

  if (/\/Type\s*\/Page(?!s)\b/.test(obj.dict)) {
    out.push(ref);
    return;
  }

  const kidsMatch = /\/Kids\s*\[([\s\S]*?)\]/m.exec(obj.dict);
  if (!kidsMatch) return;

  const kids = parseRefs(kidsMatch[1]);
  for (const kid of kids) collectPages(kid, objects, out, seen, warnings);
}

function getContentsRefs(page: PdfObject): PdfRef[] {
  const arrayMatch = /\/Contents\s*\[([\s\S]*?)\]/m.exec(page.dict);
  if (arrayMatch) return parseRefs(arrayMatch[1]);

  const single = /\/Contents\s+(\d+)\s+(\d+)\s+R/.exec(page.dict);
  if (single) return [{ num: Number(single[1]), gen: Number(single[2]) }];

  return [];
}

function parseLiteralString(src: string, start: number): { value: string; end: number } {
  let i = start + 1;
  let depth = 1;
  let out = "";

  while (i < src.length && depth > 0) {
    const ch = src[i++];
    if (ch === "\\") {
      if (i >= src.length) break;
      const esc = src[i++];

      if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else if (esc === "\n") {
        // line continuation
      } else if (esc === "\r") {
        if (src[i] === "\n") i++;
      } else if (/[0-7]/.test(esc)) {
        let oct = esc;
        for (let j = 0; j < 2 && i < src.length && /[0-7]/.test(src[i]); j++) oct += src[i++];
        out += String.fromCharCode(parseInt(oct, 8));
      } else {
        out += esc;
      }
      continue;
    }

    if (ch === "(") {
      depth += 1;
      out += ch;
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      if (depth > 0) out += ch;
      continue;
    }

    out += ch;
  }

  return { value: out, end: i };
}

function parseHexString(src: string, start: number): { value: string; end: number } {
  let i = start + 1;
  let hex = "";
  while (i < src.length && src[i] !== ">") {
    if (/[0-9A-Fa-f]/.test(src[i])) hex += src[i];
    i++;
  }
  if (i < src.length && src[i] === ">") i++;
  if (hex.length % 2 === 1) hex += "0";
  const value = Buffer.from(hex, "hex").toString("latin1");
  return { value, end: i };
}

function parseArrayStrings(src: string, start: number): { values: string[]; end: number } {
  let i = start + 1;
  const values: string[] = [];

  while (i < src.length) {
    const ch = src[i];
    if (ch === "]") {
      i++;
      break;
    }

    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    if (ch === "%") {
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }

    if (ch === "(") {
      const lit = parseLiteralString(src, i);
      values.push(lit.value);
      i = lit.end;
      continue;
    }

    if (ch === "<" && src[i + 1] !== "<") {
      const hex = parseHexString(src, i);
      values.push(hex.value);
      i = hex.end;
      continue;
    }

    while (i < src.length && !isWhitespace(src[i]) && src[i] !== "]") i++;
  }

  return { values, end: i };
}

type Operand =
  | { kind: "string"; value: string }
  | { kind: "array"; value: string[] }
  | { kind: "number"; value: number }
  | { kind: "other"; value: string };

function popLastString(operands: Operand[]): string {
  for (let i = operands.length - 1; i >= 0; i--) {
    const op = operands[i];
    if (op.kind === "string") return op.value;
  }
  return "";
}

function popLastArrayText(operands: Operand[]): string {
  for (let i = operands.length - 1; i >= 0; i--) {
    const op = operands[i];
    if (op.kind === "array") return op.value.join("");
  }
  return "";
}

function getSecondNumericOperand(operands: Operand[]): number | null {
  const nums = operands.filter((o): o is { kind: "number"; value: number } => o.kind === "number");
  if (nums.length < 2) return null;
  return nums[nums.length - 1].value;
}

function parseTextSegment(segment: string): string {
  const operands: Operand[] = [];
  const out: string[] = [];
  let i = 0;

  const pushNewline = () => {
    if (!out.length || out[out.length - 1] === "\n") return;
    out.push("\n");
  };

  const pushText = (text: string) => {
    if (!text) return;
    out.push(text);
  };

  while (i < segment.length) {
    const ch = segment[i];
    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    if (ch === "%") {
      while (i < segment.length && segment[i] !== "\n" && segment[i] !== "\r") i++;
      continue;
    }

    if (ch === "(") {
      const lit = parseLiteralString(segment, i);
      operands.push({ kind: "string", value: lit.value });
      i = lit.end;
      continue;
    }

    if (ch === "<" && segment[i + 1] !== "<") {
      const hex = parseHexString(segment, i);
      operands.push({ kind: "string", value: hex.value });
      i = hex.end;
      continue;
    }

    if (ch === "[") {
      const arr = parseArrayStrings(segment, i);
      operands.push({ kind: "array", value: arr.values });
      i = arr.end;
      continue;
    }

    const start = i;
    while (i < segment.length && !isDelimiter(segment[i])) i++;
    const token = segment.slice(start, i);
    if (!token) {
      i++;
      continue;
    }

    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      operands.push({ kind: "number", value: Number(token) });
      continue;
    }

    if (
      token === "Tj" ||
      token === "TJ" ||
      token === "'" ||
      token === "\"" ||
      token === "T*" ||
      token === "Td" ||
      token === "TD" ||
      token === "Tm"
    ) {
      if (token === "Tj") pushText(popLastString(operands));
      else if (token === "TJ") pushText(popLastArrayText(operands));
      else if (token === "'") {
        pushNewline();
        pushText(popLastString(operands));
      } else if (token === "\"") {
        pushNewline();
        pushText(popLastString(operands));
      } else if (token === "T*") {
        pushNewline();
      } else if (token === "Td" || token === "TD" || token === "Tm") {
        const y = getSecondNumericOperand(operands);
        if (y !== null && Math.abs(y) > 0.001) pushNewline();
      }
      operands.length = 0;
      continue;
    }

    operands.push({ kind: "other", value: token });
  }

  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000/g, "")
    .trim();
}

function extractTextFromContent(content: string): string {
  const blocks: string[] = [];
  const btEt = /BT([\s\S]*?)ET/g;
  let found = false;
  let m: RegExpExecArray | null;

  while ((m = btEt.exec(content)) !== null) {
    found = true;
    const t = parseTextSegment(m[1] ?? "");
    if (t) blocks.push(t);
  }

  if (!found) {
    const t = parseTextSegment(content);
    if (t) blocks.push(t);
  }

  return blocks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPageText(
  pageObj: PdfObject,
  objects: Map<string, PdfObject>,
  warnings: string[]
): string {
  const refs = getContentsRefs(pageObj);
  const streams: Buffer[] = [];

  if (refs.length) {
    for (const ref of refs) {
      const obj = objects.get(refKey(ref));
      if (!obj) {
        warnings.push(`Missing contents object ${ref.num} ${ref.gen} for page ${pageObj.ref.num}.`);
        continue;
      }
      const decoded = decodeStream(obj, warnings);
      if (decoded) streams.push(decoded);
    }
  } else {
    const decoded = decodeStream(pageObj, warnings);
    if (decoded) streams.push(decoded);
  }

  if (!streams.length) return "";
  const content = Buffer.concat(streams).toString("latin1");
  return extractTextFromContent(content);
}

export function extractPdfTextPreview(bytes: Uint8Array): PdfTextPreview {
  const warnings: string[] = [];
  const objects = parseObjects(bytes);
  if (!objects.size) {
    return {
      pages: [],
      warnings: ["No PDF objects were parsed. File may be malformed or unsupported by the native parser."]
    };
  }

  expandObjectStreams(objects, warnings);

  const pageRefs = getPageRefs(objects, warnings);
  if (!pageRefs.length) {
    return {
      pages: [],
      warnings: [...warnings, "No /Page objects found in PDF structure."]
    };
  }

  const pages: string[] = [];
  for (const ref of pageRefs) {
    const pageObj = objects.get(refKey(ref));
    if (!pageObj) {
      warnings.push(`Page object ${ref.num} ${ref.gen} missing.`);
      pages.push("");
      continue;
    }

    pages.push(extractPageText(pageObj, objects, warnings));
  }

  return { pages, warnings };
}
