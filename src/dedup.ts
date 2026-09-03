export class EventDeduplicator {
  private seen = new Map<string, number>()

  constructor(
    private readonly ttl = 120_000,
    private readonly maxSize = 4096,
  ) {}

  isDuplicate(key: string | undefined): boolean {
    if (!key) return false
    const now = Date.now()
    if (this.seen.size >= this.maxSize) this.cleanup(now)
    if (this.seen.has(key)) {
      this.seen.set(key, now)
      return true
    }
    this.seen.set(key, now)
    return false
  }

  clear(): void {
    this.seen.clear()
  }

  private cleanup(now: number): void {
    for (const [key, time] of this.seen) {
      if (now - time > this.ttl) this.seen.delete(key)
    }
    if (this.seen.size >= this.maxSize) {
      const drop = this.seen.size - this.maxSize
      let dropped = 0
      for (const key of this.seen.keys()) {
        this.seen.delete(key)
        if (++dropped >= drop) break
      }
    }
  }
}
