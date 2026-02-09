export interface Chunk {
  text: string;
  start: number;    // Character offset in file
  end: number;
  startLine: number; // 1-based
  endLine: number;
}

export interface ChunkingStrategy {
  chunk(text: string, maxChars: number): Chunk[];
}