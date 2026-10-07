/** Portable INSERTs of the canonical fixture rows (the DDL is engine-specific). */
export function seedStatements(prefix: string): string[] {
  return [
    `INSERT INTO ${prefix}users (id, name, age, bio) VALUES (1, 'ada', 36, NULL)`,
    `INSERT INTO ${prefix}users (id, name, age, bio) VALUES (2, 'bob', 12, NULL)`,
    `INSERT INTO ${prefix}users (id, name, age, bio) VALUES (3, 'cy', 41, 'x')`,
    `INSERT INTO ${prefix}posts (id, user_id, title) VALUES (1, 1, 'hello')`,
    `INSERT INTO ${prefix}posts (id, user_id, title) VALUES (2, 1, 'world')`,
    `INSERT INTO ${prefix}pair (a, b, v) VALUES (1, 1, 'x')`,
    `INSERT INTO ${prefix}pair (a, b, v) VALUES (1, 2, 'y')`,
    `INSERT INTO ${prefix}nokey (a, b) VALUES (1, 'x')`,
    `INSERT INTO ${prefix}nokey (a, b) VALUES (1, 'x')`,
  ];
}

/** Child tables first, so a plain DELETE never trips a foreign key. */
export const EDIT_TABLES_CHILD_FIRST = ['edit_posts', 'edit_pair', 'edit_nokey', 'edit_users'];
