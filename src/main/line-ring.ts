/**
 * The last N lines of a stream, kept in memory. The database worker prints to
 * stdout / stderr in arbitrary chunks and nothing writes it to a file, so the
 * support bundle reads what it printed from here.
 */
export class LineRing {
  private lines: string[] = [];
  private partial = '';

  constructor(private readonly capacity: number) {}

  /** Add a chunk of output; complete lines are kept, a trailing partial line waits for its end. */
  push(chunk: string | Buffer, prefix = ''): void {
    const text = this.partial + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    const parts = text.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      this.lines.push(prefix + line);
    }
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    // A line that never ends must not grow without bound.
    if (this.partial.length > 8192) {
      this.lines.push(`${prefix}${this.partial.slice(0, 8192)}…`);
      this.partial = '';
    }
  }

  /** What has been kept, oldest first, including a line still being written. */
  text(): string {
    return [...this.lines, ...(this.partial ? [this.partial] : [])].join('\n');
  }

  get size(): number {
    return this.lines.length;
  }
}

/** What the database worker printed since Plasma started (stderr lines are tagged `[worker:err]`). */
export const workerOutput = new LineRing(2000);
