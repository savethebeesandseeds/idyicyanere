import { Chunk, ChunkingStrategy } from "./types";

export class FixedChunker implements ChunkingStrategy {
  chunk(text: string, size: number): Chunk[] {
    const out: Chunk[] = [];
    if (!text || size <= 0) return out;

    let line = 1;

    for (let i = 0; i < text.length; i += size) {
      const chunkText = text.slice(i, i + size);
      const start = i;
      const end = i + chunkText.length;
      const startLine = line;
      
      // Calculate how many newlines are in this specific slice
      const nl = this.countNewlines(chunkText);
      const endLine = startLine + nl;

      out.push({ text: chunkText, start, end, startLine, endLine });

      // If the chunk ended with a newline, the next chunk starts on the next line
      // If it split in the middle of a line, the next chunk starts on the same line (technically)
      // But for simple slicing, we just accumulate the lines found.
      line = endLine; 
    }

    return out;
  }

  private countNewlines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  }
}