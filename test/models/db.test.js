const test = require("node:test");
const assert = require("node:assert/strict");
const { rollback, withTransaction } = require("../../src/models/db");

function fakePool(log, { failQuery } = {}) {
    return {
        async connect() {
            return {
                async query(sql) {
                    log.push(sql);
                    if (sql === failQuery) throw new Error("boom");
                },
                release(error) { log.push(error ? "release:discard" : "release"); }
            };
        }
    };
}

test("事务正常完成时提交", async () => {
    const log = [];
    assert.equal(await withTransaction(fakePool(log), async client => { await client.query("WRITE"); return 1; }), 1);
    assert.deepEqual(log, ["BEGIN", "WRITE", "COMMIT", "release"]);
});

test("返回rollback()时回滚并返回其值", async () => {
    const log = [];
    assert.equal(await withTransaction(fakePool(log), async client => { await client.query("WRITE"); return rollback(null); }), null);
    assert.deepEqual(log, ["BEGIN", "WRITE", "ROLLBACK", "release"]);
});

test("出错时回滚并丢弃连接", async () => {
    const log = [];
    await assert.rejects(withTransaction(fakePool(log, { failQuery: "WRITE" }), client => client.query("WRITE")), /boom/);
    assert.deepEqual(log, ["BEGIN", "WRITE", "ROLLBACK", "release:discard"]);
});
