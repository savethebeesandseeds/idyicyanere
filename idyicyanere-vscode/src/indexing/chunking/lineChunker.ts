import { Chunk, ChunkingStrategy } from "./types";

export class LineChunker implements ChunkingStrategy {
  chunk(text: string, maxChars: number): Chunk[] {
    const out: Chunk[] = [];
    if (!text || maxChars <= 0) return out;

    const lines = text.split(/\r\n|\r|\n/);
    
    let currentChunkLines: string[] = [];
    let currentSize = 0;
    let chunkStartOffset = 0;
    let chunkStartLine = 1;
    
    // We track the global offset to calculate start/end correctly
    let scanOffset = 0; 

    for (let i = 0; i < lines.length; i++) {
      // Re-add the newline char for size calculation and reconstruction
      // (The last line might not have one, but for chunking estimation it's safer to assume)
      const lineText = lines[i] + "\n"; 
      const len = lineText.length;

      // 1. Edge Case: Single line is bigger than the limit (e.g. minified code)
      if (len > maxChars) {
        // If we have pending content, flush it first
        if (currentChunkLines.length > 0) {
          this.flush(out, currentChunkLines, chunkStartOffset, chunkStartLine);
          currentChunkLines = [];
          currentSize = 0;
        }

        // Force split this massive line
        // We temporarily use the fixed logic just for this segment, or store it as is
        // For safety in RAG, we stick it in as one massive chunk or truncate. 
        // Let's truncate/slice it to ensure we don't break the DB limit.
        this.sliceMassiveLine(out, lines[i], scanOffset, i + 1, maxChars);
        
        chunkStartLine = i + 2;
        scanOffset += lines[i].length + 1; // +1 for the newline we split by
        chunkStartOffset = scanOffset;
        continue;
      }

      // 2. Normal Case: Check if adding this line exceeds limit
      if (currentSize + len > maxChars && currentChunkLines.length > 0) {
        this.flush(out, currentChunkLines, chunkStartOffset, chunkStartLine);
        
        // Reset for next chunk
        chunkStartOffset = scanOffset;
        chunkStartLine = i + 1;
        currentChunkLines = [];
        currentSize = 0;
      }

      currentChunkLines.push(lines[i]); // Store raw line without forced newline for now
      currentSize += len;
      scanOffset += lines[i].length + 1; // +1 assumes standard \n split
    }

    // Flush remaining
    if (currentChunkLines.length > 0) {
      this.flush(out, currentChunkLines, chunkStartOffset, chunkStartLine);
    }

    return out;
  }

  private flush(out: Chunk[], lines: string[], start: number, startLine: number) {
    // Rejoin lines. Note: split() removes separators, so we re-add \n.
    // This implies the chunk text is normalized to \n.
    const text = lines.join("\n");
    out.push({
      text,
      start,
      end: start + text.length,
      startLine,
      endLine: startLine + lines.length - 1
    });
  }

  private sliceMassiveLine(out: Chunk[], line: string, startOffset: number, lineNum: number, maxChars: number) {
    for (let i = 0; i < line.length; i += maxChars) {
      const part = line.slice(i, i + maxChars);
      out.push({
        text: part,
        start: startOffset + i,
        end: startOffset + i + part.length,
        startLine: lineNum,
        endLine: lineNum 
      });
    }
  }
}