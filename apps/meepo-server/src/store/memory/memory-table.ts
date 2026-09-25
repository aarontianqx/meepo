/** Shared map-backed base for in-memory repositories. */
export abstract class MemoryTable<T extends { id: string }> {
  protected readonly rows = new Map<string, T>();

  async save(row: T): Promise<void> {
    this.rows.set(row.id, structuredClone(row));
  }

  async getById(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async list(): Promise<T[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}
