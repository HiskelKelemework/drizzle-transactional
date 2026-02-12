import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDrizzleTransactional,
  BaseRepository,
  Propagation,
  type DrizzleDatabase,
} from "./index";

// ---------------------------------------------------------------------------
// Mock Drizzle database
// ---------------------------------------------------------------------------

interface MockTx extends DrizzleDatabase {
  id: string;
}

interface MockDb extends DrizzleDatabase {
  id: string;
}

/**
 * Creates a mock Drizzle database that records BEGIN/COMMIT/ROLLBACK/SAVEPOINT
 * operations so tests can assert on transaction lifecycle.
 */
function createMockDb() {
  const log: string[] = [];
  let idCounter = 0;

  function makeTx(label: string): MockTx {
    return {
      id: label,
      async transaction(fn) {
        const spId = `savepoint-${++idCounter}`;
        log.push(`SAVEPOINT ${spId}`);
        try {
          const result = await fn(makeTx(spId));
          log.push(`RELEASE ${spId}`);
          return result;
        } catch (error) {
          log.push(`ROLLBACK TO ${spId}`);
          throw error;
        }
      },
    };
  }

  const db: MockDb = {
    id: "root-db",
    async transaction(fn) {
      const txId = `tx-${++idCounter}`;
      log.push(`BEGIN ${txId}`);
      try {
        const result = await fn(makeTx(txId));
        log.push(`COMMIT ${txId}`);
        return result;
      } catch (error) {
        log.push(`ROLLBACK ${txId}`);
        throw error;
      }
    },
  };

  return { db, log };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const { db, log } = createMockDb();
  const { withTransaction, transaction, transactionStorage } =
    createDrizzleTransactional(db);

  class TestRepository extends BaseRepository<MockDb> {
    constructor() {
      super(db, transactionStorage);
    }
    /** Expose dbInstance for testing. */
    get currentDbInstance() {
      return this.dbInstance;
    }
  }

  return { db, log, withTransaction, transaction, transactionStorage, TestRepository };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("withTransaction", () => {
  // -----------------------------------------------------------------------
  // REQUIRED (default)
  // -----------------------------------------------------------------------
  describe("Propagation.REQUIRED (default)", () => {
    it("creates a new transaction when none exists", async () => {
      const { withTransaction, log } = setup();

      const result = await withTransaction(async () => "ok");

      expect(result).toBe("ok");
      expect(log).toEqual([expect.stringContaining("BEGIN"), expect.stringContaining("COMMIT")]);
    });

    it("reuses the existing transaction (no new BEGIN)", async () => {
      const { withTransaction, log, transactionStorage } = setup();

      await withTransaction(async () => {
        // Inner call should NOT create a new transaction
        const innerResult = await withTransaction(async () => "inner");
        expect(innerResult).toBe("inner");
        return "outer";
      });

      // Only one BEGIN/COMMIT pair
      const begins = log.filter((l) => l.startsWith("BEGIN"));
      expect(begins).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // MANDATORY
  // -----------------------------------------------------------------------
  describe("Propagation.MANDATORY", () => {
    it("throws when no existing transaction", async () => {
      const { withTransaction } = setup();

      await expect(
        withTransaction(async () => "never", { propagation: Propagation.MANDATORY })
      ).rejects.toThrow("Propagation.MANDATORY");
    });

    it("reuses existing transaction without creating a new one", async () => {
      const { withTransaction, log } = setup();

      const result = await withTransaction(async () => {
        return withTransaction(async () => "inner", {
          propagation: Propagation.MANDATORY,
        });
      });

      expect(result).toBe("inner");
      const begins = log.filter((l) => l.startsWith("BEGIN"));
      expect(begins).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // NESTED
  // -----------------------------------------------------------------------
  describe("Propagation.NESTED", () => {
    it("creates a new transaction when none exists (like REQUIRED)", async () => {
      const { withTransaction, log } = setup();

      const result = await withTransaction(async () => "ok", {
        propagation: Propagation.NESTED,
      });

      expect(result).toBe("ok");
      expect(log).toEqual([expect.stringContaining("BEGIN"), expect.stringContaining("COMMIT")]);
    });

    it("creates a savepoint when inside an existing transaction", async () => {
      const { withTransaction, log } = setup();

      await withTransaction(async () => {
        await withTransaction(async () => "nested", {
          propagation: Propagation.NESTED,
        });
        return "outer";
      });

      expect(log.some((l) => l.startsWith("SAVEPOINT"))).toBe(true);
      expect(log.some((l) => l.startsWith("RELEASE"))).toBe(true);
    });

    it("rolls back only the savepoint on nested error, outer continues", async () => {
      const { withTransaction, log } = setup();

      const result = await withTransaction(async () => {
        try {
          await withTransaction(
            async () => {
              throw new Error("nested failure");
            },
            { propagation: Propagation.NESTED }
          );
        } catch {
          // swallow — outer should continue
        }
        return "outer survived";
      });

      expect(result).toBe("outer survived");
      expect(log.some((l) => l.startsWith("ROLLBACK TO"))).toBe(true);
      expect(log.some((l) => l.startsWith("COMMIT"))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // NEVER
  // -----------------------------------------------------------------------
  describe("Propagation.NEVER", () => {
    it("runs non-transactionally when no transaction exists", async () => {
      const { withTransaction, log } = setup();

      const result = await withTransaction(async () => "ok", {
        propagation: Propagation.NEVER,
      });

      expect(result).toBe("ok");
      expect(log).toHaveLength(0);
    });

    it("throws when a transaction exists", async () => {
      const { withTransaction } = setup();

      await expect(
        withTransaction(async () => {
          return withTransaction(async () => "never", {
            propagation: Propagation.NEVER,
          });
        })
      ).rejects.toThrow("Propagation.NEVER");
    });
  });

  // -----------------------------------------------------------------------
  // NOT_SUPPORTED
  // -----------------------------------------------------------------------
  describe("Propagation.NOT_SUPPORTED", () => {
    it("runs non-transactionally when no transaction exists", async () => {
      const { withTransaction, log } = setup();

      const result = await withTransaction(async () => "ok", {
        propagation: Propagation.NOT_SUPPORTED,
      });

      expect(result).toBe("ok");
      expect(log).toHaveLength(0);
    });

    it("suspends the current transaction", async () => {
      const { withTransaction, transactionStorage, TestRepository } = setup();
      const repo = new TestRepository();

      let innerDbId: string | undefined;

      await withTransaction(async () => {
        // Inside a transaction, dbInstance should be the tx
        const txDbId = repo.currentDbInstance.id;
        expect(txDbId).toMatch(/^tx-/);

        await withTransaction(
          async () => {
            // Inside NOT_SUPPORTED, dbInstance should be root db
            innerDbId = repo.currentDbInstance.id;
          },
          { propagation: Propagation.NOT_SUPPORTED }
        );

        return "done";
      });

      expect(innerDbId).toBe("root-db");
    });
  });

  // -----------------------------------------------------------------------
  // REQUIRES_NEW
  // -----------------------------------------------------------------------
  describe("Propagation.REQUIRES_NEW", () => {
    it("creates a new transaction when none exists", async () => {
      const { withTransaction, log } = setup();

      const result = await withTransaction(async () => "ok", {
        propagation: Propagation.REQUIRES_NEW,
      });

      expect(result).toBe("ok");
      expect(log).toEqual([expect.stringContaining("BEGIN"), expect.stringContaining("COMMIT")]);
    });

    it("creates a new independent transaction even when one exists", async () => {
      const { withTransaction, log } = setup();

      await withTransaction(async () => {
        await withTransaction(async () => "inner", {
          propagation: Propagation.REQUIRES_NEW,
        });
        return "outer";
      });

      const begins = log.filter((l) => l.startsWith("BEGIN"));
      expect(begins).toHaveLength(2);
      const commits = log.filter((l) => l.startsWith("COMMIT"));
      expect(commits).toHaveLength(2);
    });

    it("inner REQUIRES_NEW commits independently even if outer rolls back", async () => {
      const { withTransaction, log } = setup();

      let innerCommitted = false;

      try {
        await withTransaction(async () => {
          await withTransaction(
            async () => {
              innerCommitted = true;
              return "inner";
            },
            { propagation: Propagation.REQUIRES_NEW }
          );

          throw new Error("outer fails");
        });
      } catch {
        // expected
      }

      expect(innerCommitted).toBe(true);
      // Inner committed, outer rolled back
      expect(log.filter((l) => l.startsWith("COMMIT"))).toHaveLength(1);
      expect(log.filter((l) => l.startsWith("ROLLBACK t"))).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // SUPPORTS
  // -----------------------------------------------------------------------
  describe("Propagation.SUPPORTS", () => {
    it("runs non-transactionally when no transaction exists", async () => {
      const { withTransaction, log } = setup();

      const result = await withTransaction(async () => "ok", {
        propagation: Propagation.SUPPORTS,
      });

      expect(result).toBe("ok");
      expect(log).toHaveLength(0);
    });

    it("reuses existing transaction when one exists", async () => {
      const { withTransaction, log, TestRepository } = setup();
      const repo = new TestRepository();

      let innerDbId: string | undefined;

      await withTransaction(async () => {
        await withTransaction(
          async () => {
            innerDbId = repo.currentDbInstance.id;
          },
          { propagation: Propagation.SUPPORTS }
        );
        return "done";
      });

      expect(innerDbId).toMatch(/^tx-/);
      const begins = log.filter((l) => l.startsWith("BEGIN"));
      expect(begins).toHaveLength(1);
    });
  });
});

// ===========================================================================
// shouldRollback
// ===========================================================================

describe("shouldRollback", () => {
  it("commits when shouldRollback returns false", async () => {
    const { withTransaction, log } = setup();

    const result = await withTransaction(async () => ({ ok: true }), {
      shouldRollback: (r) => !r.ok,
    });

    expect(result).toEqual({ ok: true });
    expect(log.some((l) => l.startsWith("COMMIT"))).toBe(true);
    expect(log.some((l) => l.startsWith("ROLLBACK"))).toBe(false);
  });

  it("rolls back and still returns the result when shouldRollback returns true", async () => {
    const { withTransaction, log } = setup();

    const result = await withTransaction(
      async () => ({ ok: false, error: "bad" }),
      {
        shouldRollback: (r) => !r.ok,
      }
    );

    expect(result).toEqual({ ok: false, error: "bad" });
    expect(log.some((l) => l.startsWith("ROLLBACK"))).toBe(true);
    expect(log.some((l) => l.startsWith("COMMIT"))).toBe(false);
  });

  it("works with the @transaction() decorator", async () => {
    const { transaction, log } = setup();

    class TestUseCase {
      @transaction({ shouldRollback: (r: { ok: boolean }) => !r.ok })
      async execute() {
        return { ok: false };
      }
    }

    const uc = new TestUseCase();
    const result = await uc.execute();

    expect(result).toEqual({ ok: false });
    expect(log.some((l) => l.startsWith("ROLLBACK"))).toBe(true);
  });

  it("works with NESTED propagation (rolls back savepoint)", async () => {
    const { withTransaction, log } = setup();

    const result = await withTransaction(async () => {
      const nested = await withTransaction(
        async () => ({ ok: false }),
        {
          propagation: Propagation.NESTED,
          shouldRollback: (r) => !r.ok,
        }
      );
      return { outer: "ok", nested };
    });

    expect(result.nested).toEqual({ ok: false });
    // Savepoint was rolled back
    expect(log.some((l) => l.startsWith("ROLLBACK TO"))).toBe(true);
    // Outer was committed
    expect(log.some((l) => l.startsWith("COMMIT"))).toBe(true);
  });

  it("works with REQUIRES_NEW propagation", async () => {
    const { withTransaction, log } = setup();

    const result = await withTransaction(async () => {
      const inner = await withTransaction(
        async () => ({ ok: false }),
        {
          propagation: Propagation.REQUIRES_NEW,
          shouldRollback: (r) => !r.ok,
        }
      );
      return { outer: "ok", inner };
    });

    expect(result.inner).toEqual({ ok: false });
    // Inner tx rolled back, outer committed
    const rollbacks = log.filter((l) => l.startsWith("ROLLBACK t"));
    const commits = log.filter((l) => l.startsWith("COMMIT"));
    expect(rollbacks).toHaveLength(1);
    expect(commits).toHaveLength(1);
  });
});

// ===========================================================================
// Error handling
// ===========================================================================

describe("error handling", () => {
  it("rolls back and re-throws when fn throws", async () => {
    const { withTransaction, log } = setup();

    await expect(
      withTransaction(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(log.some((l) => l.startsWith("ROLLBACK"))).toBe(true);
    expect(log.some((l) => l.startsWith("COMMIT"))).toBe(false);
  });

  it("propagates the original error type", async () => {
    const { withTransaction } = setup();

    class CustomError extends Error {
      code = "CUSTOM";
    }

    try {
      await withTransaction(async () => {
        throw new CustomError("custom");
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CustomError);
      expect((error as CustomError).code).toBe("CUSTOM");
    }
  });
});

// ===========================================================================
// @transaction() decorator
// ===========================================================================

describe("@transaction() decorator", () => {
  it("wraps a method in a REQUIRED transaction by default", async () => {
    const { transaction, log } = setup();

    class Service {
      @transaction()
      async doWork() {
        return "done";
      }
    }

    const svc = new Service();
    const result = await svc.doWork();

    expect(result).toBe("done");
    expect(log).toEqual([expect.stringContaining("BEGIN"), expect.stringContaining("COMMIT")]);
  });

  it("passes propagation through to withTransaction", async () => {
    const { transaction, withTransaction } = setup();

    class Service {
      @transaction({ propagation: Propagation.MANDATORY })
      async doWork() {
        return "done";
      }
    }

    const svc = new Service();

    // Should throw without a surrounding transaction
    await expect(svc.doWork()).rejects.toThrow("Propagation.MANDATORY");

    // Should work inside a transaction
    const result = await withTransaction(async () => svc.doWork());
    expect(result).toBe("done");
  });

  it("preserves `this` context", async () => {
    const { transaction } = setup();

    class Service {
      name = "test-service";

      @transaction()
      async doWork() {
        return this.name;
      }
    }

    const svc = new Service();
    const result = await svc.doWork();
    expect(result).toBe("test-service");
  });

  it("passes arguments correctly", async () => {
    const { transaction } = setup();

    class Service {
      @transaction()
      async add(a: number, b: number) {
        return a + b;
      }
    }

    const svc = new Service();
    expect(await svc.add(3, 4)).toBe(7);
  });
});

// ===========================================================================
// BaseRepository
// ===========================================================================

describe("BaseRepository", () => {
  it("returns root db when not inside a transaction", () => {
    const { db, transactionStorage } = setup();

    class Repo extends BaseRepository<MockDb> {
      constructor() {
        super(db, transactionStorage);
      }
      get current() {
        return this.dbInstance;
      }
    }

    const repo = new Repo();
    expect(repo.current.id).toBe("root-db");
  });

  it("returns the transaction context when inside a transaction", async () => {
    const { db, withTransaction, transactionStorage } = setup();

    class Repo extends BaseRepository<MockDb> {
      constructor() {
        super(db, transactionStorage);
      }
      get current() {
        return this.dbInstance;
      }
    }

    const repo = new Repo();

    await withTransaction(async () => {
      expect(repo.current.id).toMatch(/^tx-/);
    });

    // Back to root after transaction
    expect(repo.current.id).toBe("root-db");
  });

  it("returns root db inside NOT_SUPPORTED even when outer tx exists", async () => {
    const { db, withTransaction, transactionStorage } = setup();

    class Repo extends BaseRepository<MockDb> {
      constructor() {
        super(db, transactionStorage);
      }
      get current() {
        return this.dbInstance;
      }
    }

    const repo = new Repo();

    await withTransaction(async () => {
      expect(repo.current.id).toMatch(/^tx-/);

      await withTransaction(
        async () => {
          expect(repo.current.id).toBe("root-db");
        },
        { propagation: Propagation.NOT_SUPPORTED }
      );

      // Restored after NOT_SUPPORTED
      expect(repo.current.id).toMatch(/^tx-/);
    });
  });
});

// ===========================================================================
// Propagation object
// ===========================================================================

describe("Propagation", () => {
  it("exports all expected propagation levels", () => {
    expect(Propagation.MANDATORY).toBe("MANDATORY");
    expect(Propagation.NESTED).toBe("NESTED");
    expect(Propagation.NEVER).toBe("NEVER");
    expect(Propagation.NOT_SUPPORTED).toBe("NOT_SUPPORTED");
    expect(Propagation.REQUIRED).toBe("REQUIRED");
    expect(Propagation.REQUIRES_NEW).toBe("REQUIRES_NEW");
    expect(Propagation.SUPPORTS).toBe("SUPPORTS");
  });
});
