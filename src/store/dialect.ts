import {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  CompiledQuery,
} from "kysely";
import { Database as BunSqliteDatabase } from "bun:sqlite";

interface BunSqliteDialectConfig {
  database: BunSqliteDatabase;
}

export class BunSqliteDialect implements Dialect {
  readonly #config: BunSqliteDialectConfig;

  constructor(config: BunSqliteDialectConfig) {
    this.#config = config;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new BunSqliteDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class BunSqliteDriver implements Driver {
  readonly #config: BunSqliteDialectConfig;

  constructor(config: BunSqliteDialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new BunSqliteConnection(this.#config.database);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN IMMEDIATE"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {
    this.#config.database.close();
  }
}

class BunSqliteConnection implements DatabaseConnection {
  readonly #db: BunSqliteDatabase;

  constructor(db: BunSqliteDatabase) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.#db.prepare(sql);

    // Detect if this is a SELECT-like query by checking the SQL
    const isSelect = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql);

    if (isSelect) {
      const rows = stmt.all(...(parameters as unknown[])) as R[];
      return { rows };
    }

    const result = stmt.run(...(parameters as unknown[]));
    return {
      rows: [],
      numAffectedRows: BigInt((result as any).changes ?? 0),
      insertId: BigInt((result as any).lastInsertRowid ?? 0),
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming not supported with bun:sqlite");
  }
}
