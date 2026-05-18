import { readFile } from "node:fs";

const DEFAULT_LIMIT = 10;

/**
 * Fetch a user record by id.
 */
export async function fetchUser(id: string): Promise<User> {
  const raw = await readFile(id, "utf8");
  return JSON.parse(raw) as User;
}

export interface User {
  id: string;
  name: string;
}

export class UserCache {
  private store = new Map<string, User>();

  get(id: string): User | undefined {
    return this.store.get(id);
  }

  set(id: string, user: User): void {
    this.store.set(id, user);
  }
}

const makeHandler = (limit: number) => {
  return (id: string) => fetchUser(id).catch(() => null);
};

console.log(DEFAULT_LIMIT, makeHandler);
