# drizzle-transactional

Nested transaction support for [Drizzle ORM](https://orm.drizzle.team/) with decorator and programmatic APIs, `AsyncLocalStorage`-based context propagation, and custom rollback control.

- **Zero runtime dependencies** — only uses Node.js built-in `async_hooks`
- **Propagation levels** — Spring-style transaction propagation (`REQUIRED`, `MANDATORY`, `NESTED`, `NEVER`, `NOT_SUPPORTED`, `REQUIRES_NEW`, `SUPPORTS`)
- **Nest freely** — inner calls reuse, suspend, or create transactions based on propagation
- **Rollback on exception** — any thrown error triggers a rollback (Drizzle's default behaviour)
- **Custom rollback** — pass a `shouldRollback` callback to inspect the return value and decide
- **Decorator & functional** — use `@transaction()` on class methods or `withTransaction()` anywhere
- **Repository base class** — `BaseRepository` gives you a transaction-aware `this.dbInstance`

## Installation

```bash
npm install drizzle-transactional
# or
pnpm add drizzle-transactional
# or
yarn add drizzle-transactional
```

## Quick start

### 1. Initialise once

```ts
// src/db/transactional.ts
import { drizzle } from "drizzle-orm/postgres-js";
import { createDrizzleTransactional, BaseRepository } from "drizzle-transactional";

const db = drizzle(sql);

export const {
  withTransaction,
  transaction,
  transactionStorage,
} = createDrizzleTransactional(db);

// Create a project-level base repository so individual repos
// don't need to repeat the constructor arguments.
export abstract class AppRepository extends BaseRepository<typeof db> {
  constructor() {
    super(db, transactionStorage);
  }
}
```

### 2. Create repositories

```ts
import { AppRepository } from "./transactional";
import { users } from "./schema";

class UserRepository extends AppRepository {
  async create(data: NewUser) {
    const [user] = await this.dbInstance.insert(users).values(data).returning();
    return user;
  }
}
```

`this.dbInstance` automatically resolves to the active transaction when inside one, or the root `db` otherwise.

### 3. Use transactions

#### Decorator (class methods)

```ts
import { transaction } from "./transactional";

class CreateOrderUseCase {
  constructor(
    private orderRepo: OrderRepository,
    private inventoryRepo: InventoryRepository
  ) {}

  @transaction()
  async execute(input: CreateOrderInput) {
    const order = await this.orderRepo.create(input);
    await this.inventoryRepo.decrement(input.sku, input.qty);
    return order;
    // If either call throws, the entire transaction is rolled back.
  }
}
```

#### Programmatic

```ts
import { withTransaction } from "./transactional";

const order = await withTransaction(async () => {
  const order = await orderRepo.create(input);
  await inventoryRepo.decrement(input.sku, input.qty);
  return order;
});
```

## Propagation levels

Control how transactions interact when calls are nested. Pass `propagation` in the options object of `withTransaction()` or `@transaction()`. Defaults to `REQUIRED`.

```ts
import { Propagation } from "drizzle-transactional";
```

| Level            | Existing tx? | Behaviour                                              |
|------------------|-------------|--------------------------------------------------------|
| `REQUIRED`       | yes         | Reuse it                                               |
|                  | no          | Create a new transaction                               |
| `MANDATORY`      | yes         | Reuse it                                               |
|                  | no          | **Throw** — caller must already be in a transaction    |
| `NESTED`         | yes         | Create a savepoint (`tx.transaction()`)                |
|                  | no          | Create a new transaction (same as `REQUIRED`)          |
| `NEVER`          | yes         | **Throw** — must not be called within a transaction    |
|                  | no          | Run non-transactionally                                |
| `NOT_SUPPORTED`  | yes         | Suspend it, run non-transactionally                    |
|                  | no          | Run non-transactionally                                |
| `REQUIRES_NEW`   | yes         | Suspend it, create a **new** independent transaction   |
|                  | no          | Create a new transaction                               |
| `SUPPORTS`       | yes         | Reuse it                                               |
|                  | no          | Run non-transactionally                                |

### Examples

#### `REQUIRED` (default)

Reuses an existing transaction or creates a new one. This is the default when no propagation is specified.

```ts
class CreateOrderUseCase {
  @transaction() // Propagation.REQUIRED is the default
  async execute(input: CreateOrderInput) {
    // ...
  }
}
```

#### `MANDATORY`

Enforces that a transaction must already exist. Useful for repository methods that should never be called standalone.

```ts
class InventoryRepository extends AppRepository {
  @transaction({ propagation: Propagation.MANDATORY })
  async decrement(sku: string, qty: number) {
    // Throws if called outside a transaction.
  }
}
```

#### `NESTED`

Creates a savepoint within an existing transaction. If the nested block fails, only the savepoint is rolled back — the outer transaction can continue.

```ts
class OrderService {
  @transaction()
  async createOrder(input: CreateOrderInput) {
    const order = await this.orderRepo.create(input);

    // If loyalty update fails, only this part rolls back.
    // The order creation above survives.
    try {
      await this.updateLoyaltyPoints(order);
    } catch {
      // savepoint rolled back, continue without loyalty points
    }

    return order;
  }

  @transaction({ propagation: Propagation.NESTED })
  async updateLoyaltyPoints(order: Order) {
    // Runs in a savepoint when called from within a transaction.
    await this.loyaltyRepo.addPoints(order.userId, order.total);
  }
}
```

#### `NEVER`

Guarantees the method is never called within a transaction context.

```ts
class ReportService {
  @transaction({ propagation: Propagation.NEVER })
  async generateReport() {
    // Long-running read — must not hold a transaction open.
    // Throws if accidentally called within one.
  }
}
```

#### `NOT_SUPPORTED`

Suspends any active transaction for the duration of the call. Useful for operations that must not participate in a transaction (e.g. external API calls, logging).

```ts
class NotificationService {
  @transaction({ propagation: Propagation.NOT_SUPPORTED })
  async sendEmail(to: string, body: string) {
    // Runs outside any transaction, even if the caller is in one.
    // The caller's transaction is suspended and resumed after.
    await emailProvider.send(to, body);
  }
}
```

#### `REQUIRES_NEW`

Always starts a fresh, independent transaction — even if one already exists. The outer transaction is suspended and resumed after the new one completes. If the outer transaction later rolls back, the inner one's changes **persist**.

```ts
class AuditLogger {
  @transaction({ propagation: Propagation.REQUIRES_NEW })
  async log(event: AuditEvent) {
    // Always committed independently, even if the calling transaction fails.
    await this.auditRepo.insert(event);
  }
}
```

#### `SUPPORTS`

Joins an existing transaction if present, otherwise runs non-transactionally. Useful for read operations that can work either way.

```ts
class UserRepository extends AppRepository {
  @transaction({ propagation: Propagation.SUPPORTS })
  async findById(id: string) {
    // Uses the transaction if one exists (e.g. read-your-writes),
    // otherwise just queries without one.
    return this.dbInstance.select().from(users).where(eq(users.id, id));
  }
}
```

## Custom rollback control

By default, transactions only roll back when an exception is thrown. If you use result types (like [neverthrow](https://github.com/supermacro/neverthrow)), you can pass a `shouldRollback` callback to inspect the return value.

`shouldRollback` is meaningful for propagation levels that create or join a transaction (`REQUIRED`, `MANDATORY`, `NESTED`, `REQUIRES_NEW`).

### With `withTransaction`

```ts
import { ok, err, Result } from "neverthrow";

const result = await withTransaction(
  async () => {
    const user = await userRepo.create(data);
    if (!user) return err(new AppError("creation failed"));
    return ok(user);
  },
  {
    shouldRollback: (result) => result.isErr(),
  }
);
// If shouldRollback returns true, the transaction is rolled back
// but the result is still returned (not thrown).
```

### With `@transaction()`

```ts
class CreateUserUseCase {
  @transaction({ shouldRollback: (r: Result<User, AppError>) => r.isErr() })
  async execute(input: CreateUserInput): Promise<Result<User, AppError>> {
    const user = await this.userRepo.create(input);
    if (!user) return err(new AppError("failed"));
    return ok(user);
  }
}
```

### Combining propagation with `shouldRollback`

```ts
class PaymentService {
  @transaction({
    propagation: Propagation.REQUIRES_NEW,
    shouldRollback: (r) => r.isErr(),
  })
  async charge(input: ChargeInput): Promise<Result<Payment, AppError>> {
    // Independent transaction + automatic rollback on error Result.
  }
}
```

## API Reference

### `createDrizzleTransactional(db)`

Factory that creates transaction utilities bound to a Drizzle database instance.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `db` | Drizzle database instance | Any instance returned by `drizzle(...)` |

**Returns:**

| Property | Type | Description |
|----------|------|-------------|
| `withTransaction` | `(fn, options?) => Promise<T>` | Execute a function with transaction propagation |
| `transaction` | `(options?) => MethodDecorator` | Decorator for class methods |
| `transactionStorage` | `AsyncLocalStorage` | Raw storage — pass to `BaseRepository` subclass constructors |

### `BaseRepository<TDatabase>`

Abstract base class for repositories. Accepts the database instance and `transactionStorage` via constructor. `this.dbInstance` is transaction-aware.

| Constructor Parameter | Type | Description |
|-----------------------|------|-------------|
| `db` | `TDatabase` | Your Drizzle database instance |
| `transactionStorage` | `AsyncLocalStorage` | The `transactionStorage` from `createDrizzleTransactional` |

We recommend creating a single project-level base class:

```ts
export abstract class AppRepository extends BaseRepository<typeof db> {
  constructor() {
    super(db, transactionStorage);
  }
}
```

### `Propagation`

| Value            | Description                                                        |
|------------------|--------------------------------------------------------------------|
| `REQUIRED`       | Reuse current transaction or create a new one **(default)**        |
| `MANDATORY`      | Reuse current transaction; throw if none exists                    |
| `NESTED`         | Create a savepoint in current transaction; or new if none exists   |
| `NEVER`          | Run non-transactionally; throw if a transaction exists             |
| `NOT_SUPPORTED`  | Run non-transactionally; suspend current transaction if one exists |
| `REQUIRES_NEW`   | Always create a new independent transaction                        |
| `SUPPORTS`       | Reuse current transaction; run non-transactionally if none exists  |

### `TransactionOptions<T>`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `propagation` | `Propagation` | `"REQUIRED"` | Transaction propagation level |
| `shouldRollback` | `(result: T) => boolean` | — | Return `true` to roll back. Result is still returned. |

## How it works

1. **`AsyncLocalStorage`** stores the transaction context (`tx`) for the duration of the async call tree.
2. **`BaseRepository.dbInstance`** checks the storage on every access — if a `tx` is present, it uses it; otherwise it uses the root `db`.
3. **Propagation** determines whether to reuse, create, suspend, or reject transactions based on the current context.
4. **Suspend** (`NOT_SUPPORTED`, `REQUIRES_NEW`) works by exiting the `AsyncLocalStorage` context so nested code sees no transaction (or a fresh one).
5. **Nested** (`NESTED`) calls `tx.transaction()` which creates a savepoint in PostgreSQL/MySQL.
6. **Rollback** is triggered by exception (Drizzle's default) or by an internal `RollbackError` when `shouldRollback` returns `true`.

## Requirements

- Node.js >= 18
- Drizzle ORM >= 0.29

## License

MIT
