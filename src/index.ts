import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Internal error used to trigger a Drizzle transaction rollback
 * while preserving the return value for the caller.
 */
class RollbackError extends Error {
  constructor(public readonly result: unknown) {
    super("Transaction rollback");
    this.name = "RollbackError";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal interface that any Drizzle database instance satisfies.
 * Using this instead of importing drizzle-orm keeps the package dependency-free.
 */
export interface DrizzleDatabase {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  transaction(fn: (tx: any) => Promise<any>, config?: any): Promise<any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Transaction propagation levels, modelled after Spring's `Propagation` enum.
 *
 * | Level            | Existing tx? | Behaviour                                              |
 * |------------------|-------------|--------------------------------------------------------|
 * | `REQUIRED`       | yes         | Reuse it                                               |
 * | `REQUIRED`       | no          | Create a new transaction                               |
 * | `MANDATORY`      | yes         | Reuse it                                               |
 * | `MANDATORY`      | no          | **Throw**                                              |
 * | `NESTED`         | yes         | Create a savepoint (nested tx via `tx.transaction()`)  |
 * | `NESTED`         | no          | Create a new transaction (same as `REQUIRED`)          |
 * | `NEVER`          | yes         | **Throw**                                              |
 * | `NEVER`          | no          | Run non-transactionally                                |
 * | `NOT_SUPPORTED`  | yes         | Suspend it, run non-transactionally                    |
 * | `NOT_SUPPORTED`  | no          | Run non-transactionally                                |
 * | `REQUIRES_NEW`   | yes         | Suspend it, create a **new** independent transaction   |
 * | `REQUIRES_NEW`   | no          | Create a new transaction                               |
 * | `SUPPORTS`       | yes         | Reuse it                                               |
 * | `SUPPORTS`       | no          | Run non-transactionally                                |
 */
export const Propagation = {
  /** Support a current transaction; throw an exception if none exists. */
  MANDATORY: "MANDATORY",
  /** Execute within a nested transaction (savepoint) if a current transaction exists, behave like `REQUIRED` otherwise. */
  NESTED: "NESTED",
  /** Execute non-transactionally; throw an exception if a transaction exists. */
  NEVER: "NEVER",
  /** Execute non-transactionally; suspend the current transaction if one exists. */
  NOT_SUPPORTED: "NOT_SUPPORTED",
  /** Support a current transaction; create a new one if none exists. **(default)** */
  REQUIRED: "REQUIRED",
  /** Create a new transaction; suspend the current transaction if one exists. */
  REQUIRES_NEW: "REQUIRES_NEW",
  /** Support a current transaction; execute non-transactionally if none exists. */
  SUPPORTS: "SUPPORTS",
} as const;

/** Transaction propagation level. */
export type Propagation = (typeof Propagation)[keyof typeof Propagation];

/**
 * Options accepted by both `withTransaction` and the `@transaction()` decorator.
 */
export interface TransactionOptions<T = unknown> {
  /**
   * Transaction propagation level. Defaults to `Propagation.REQUIRED`.
   *
   * @see {@link Propagation} for a description of each level.
   */
  propagation?: Propagation;

  /**
   * Inspect the value returned by the transactional function **before** commit.
   * Return `true` to trigger a rollback. The value is still returned to the caller
   * so you can handle it (e.g. return an error Result to the consumer).
   *
   * Only meaningful for propagation levels that actually create or join a
   * transaction (`REQUIRED`, `MANDATORY`, `NESTED`, `REQUIRES_NEW`).
   *
   * @example
   * ```ts
   * await withTransaction(myFn, {
   *   shouldRollback: (result) => result.isErr(),
   * });
   * ```
   */
  shouldRollback?: (result: T) => boolean;
}

// ---------------------------------------------------------------------------
// BaseRepository (top-level for correct .d.ts emission)
// ---------------------------------------------------------------------------

/**
 * Abstract base class for repositories.
 *
 * `this.dbInstance` automatically resolves to the active transaction context
 * when inside a transaction, or the root database instance otherwise.
 *
 * Create a project-level base class to avoid repeating constructor arguments:
 *
 * @example
 * ```ts
 * const { transactionStorage } = createDrizzleTransactional(db);
 *
 * export abstract class AppRepository extends BaseRepository<typeof db> {
 *   constructor() {
 *     super(db, transactionStorage);
 *   }
 * }
 *
 * class UserRepository extends AppRepository {
 *   async create(data: NewUser) {
 *     return this.dbInstance.insert(users).values(data).returning();
 *   }
 * }
 * ```
 */
export abstract class BaseRepository<TDatabase = unknown> {
  private readonly _db: TDatabase;
  private readonly _transactionStorage: AsyncLocalStorage<unknown>;

  constructor(db: TDatabase, transactionStorage: AsyncLocalStorage<unknown>) {
    this._db = db;
    this._transactionStorage = transactionStorage;
  }

  /**
   * Returns the active transaction context if inside a transaction,
   * otherwise the root database instance.
   */
  protected get dbInstance(): TDatabase {
    return (this._transactionStorage.getStore() ?? this._db) as TDatabase;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create transaction utilities bound to a Drizzle database instance.
 *
 * @param db - Any Drizzle database instance (`drizzle(...)`)
 * @returns `{ withTransaction, transaction, transactionStorage }`
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/postgres-js";
 * import { createDrizzleTransactional } from "drizzle-transactional";
 *
 * const db = drizzle(sql);
 * export const { withTransaction, transaction, transactionStorage } =
 *   createDrizzleTransactional(db);
 * ```
 */
export function createDrizzleTransactional<TDatabase extends DrizzleDatabase>(
  db: TDatabase
) {
  const transactionStorage = new AsyncLocalStorage<unknown>();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Start a brand-new transaction on the root `db` connection and execute
   * `fn` inside it. Handles `shouldRollback` and `RollbackError`.
   */
  async function executeInNewTransaction<T>(
    fn: () => Promise<T>,
    options?: TransactionOptions<T>
  ): Promise<T> {
    try {
      return (await db.transaction(async (tx) => {
        const result = await transactionStorage.run(tx, fn);

        if (options?.shouldRollback?.(result)) {
          throw new RollbackError(result);
        }

        return result;
      })) as T;
    } catch (error) {
      if (error instanceof RollbackError) {
        return error.result as T;
      }
      throw error;
    }
  }

  /**
   * Create a savepoint (nested transaction) inside an already-active transaction
   * by calling `tx.transaction()`.
   */
  async function executeInNestedTransaction<T>(
    existingTx: unknown,
    fn: () => Promise<T>,
    options?: TransactionOptions<T>
  ): Promise<T> {
    try {
      return (await (existingTx as DrizzleDatabase).transaction(
        async (nestedTx) => {
          const result = await transactionStorage.run(nestedTx, fn);

          if (options?.shouldRollback?.(result)) {
            throw new RollbackError(result);
          }

          return result;
        }
      )) as T;
    } catch (error) {
      if (error instanceof RollbackError) {
        return error.result as T;
      }
      throw error;
    }
  }

  /**
   * Run `fn` outside any transaction context.
   * `BaseRepository.dbInstance` will resolve to the root `db`.
   */
  function executeNonTransactionally<T>(fn: () => Promise<T>): Promise<T> {
    // If we're inside a transactionStorage.run(), exit it so getStore() returns undefined.
    // If we're not, this is a no-op wrapper.
    return transactionStorage.exit(fn);
  }

  // -----------------------------------------------------------------------
  // withTransaction
  // -----------------------------------------------------------------------

  /**
   * Execute `fn` with the given transaction propagation semantics.
   *
   * @param fn - The async function to execute.
   * @param options - Optional propagation level and `shouldRollback` callback.
   *
   * @see {@link Propagation} for a detailed description of each level.
   */
  async function withTransaction<T>(
    fn: () => Promise<T>,
    options?: TransactionOptions<T>
  ): Promise<T> {
    const propagation = options?.propagation ?? Propagation.REQUIRED;
    const existingTx = transactionStorage.getStore();
    const hasExistingTx = existingTx !== undefined;

    switch (propagation) {
      // -----------------------------------------------------------------
      // REQUIRED (default) — reuse or create
      // -----------------------------------------------------------------
      case Propagation.REQUIRED:
        if (hasExistingTx) return fn();
        return executeInNewTransaction(fn, options);

      // -----------------------------------------------------------------
      // MANDATORY — reuse or throw
      // -----------------------------------------------------------------
      case Propagation.MANDATORY:
        if (!hasExistingTx) {
          throw new Error(
            "Propagation.MANDATORY: no existing transaction found. " +
              "This method must be called within an active transaction."
          );
        }
        return fn();

      // -----------------------------------------------------------------
      // NESTED — savepoint inside existing tx, otherwise create new
      // -----------------------------------------------------------------
      case Propagation.NESTED:
        if (hasExistingTx) {
          return executeInNestedTransaction(existingTx, fn, options);
        }
        return executeInNewTransaction(fn, options);

      // -----------------------------------------------------------------
      // NEVER — no transaction allowed
      // -----------------------------------------------------------------
      case Propagation.NEVER:
        if (hasExistingTx) {
          throw new Error(
            "Propagation.NEVER: an existing transaction was found. " +
              "This method must not be called within a transaction."
          );
        }
        return fn();

      // -----------------------------------------------------------------
      // NOT_SUPPORTED — suspend any existing tx, run without one
      // -----------------------------------------------------------------
      case Propagation.NOT_SUPPORTED:
        if (hasExistingTx) {
          return executeNonTransactionally(fn);
        }
        return fn();

      // -----------------------------------------------------------------
      // REQUIRES_NEW — always a fresh, independent transaction
      // -----------------------------------------------------------------
      case Propagation.REQUIRES_NEW:
        return executeInNewTransaction(fn, options);

      // -----------------------------------------------------------------
      // SUPPORTS — join if exists, otherwise run without
      // -----------------------------------------------------------------
      case Propagation.SUPPORTS:
        return fn();

      default: {
        const _exhaustive: never = propagation;
        throw new Error(`Unknown propagation level: ${_exhaustive}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // @transaction() decorator
  // -----------------------------------------------------------------------

  /**
   * Method decorator that wraps the decorated method in a transaction.
   *
   * @example
   * ```ts
   * class CreateOrderUseCase {
   *   @transaction()
   *   async execute(input: CreateOrderInput) {
   *     await this.orderRepo.create(input);
   *     await this.inventoryRepo.decrement(input.sku);
   *     return order;
   *   }
   * }
   * ```
   *
   * @example
   * ```ts
   * // With propagation and custom rollback
   * class AuditLogger {
   *   @transaction({
   *     propagation: Propagation.REQUIRES_NEW,
   *     shouldRollback: (r) => r.isErr(),
   *   })
   *   async log(event: AuditEvent): Promise<Result<void, AppError>> {
   *     // Always in its own transaction, independent of the caller's.
   *   }
   * }
   * ```
   */
  function transaction<T = unknown>(options?: TransactionOptions<T>) {
    return function (
      _target: unknown,
      _propertyKey: string,
      descriptor: PropertyDescriptor
    ) {
      const original = descriptor.value;

      descriptor.value = async function (
        this: unknown,
        ...args: unknown[]
      ) {
        return withTransaction(
          () => original.apply(this, args),
          options as TransactionOptions<unknown>
        );
      };

      return descriptor;
    };
  }

  return {
    /** Execute a function with the specified transaction propagation. */
    withTransaction,
    /** Method decorator that wraps execution in a transaction. */
    transaction,
    /** The `AsyncLocalStorage` instance — pass this to `BaseRepository` subclasses. */
    transactionStorage,
  };
}
