'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerion-load-test-'));
process.env.NODE_ENV = 'test';
process.env.ECONOMY_DATA_FILE = path.join(tempDir, 'economy.json');
delete process.env.DATABASE_URL;

const db = require('../database');
const economy = require('../economy');

async function main() {
  try {
    await db.loadDB();
    const totalUsers = 10000;
    const startedAt = process.hrtime.bigint();

    for (let i = 0; i < totalUsers; i += 1) {
      const user = db.getUser(`synthetic-${i}`);
      user.cash = 2000 + (i % 1000);
      economy.doWork(user);
      economy.doHarvest(user);
    }

    const saved = await db.saveDB();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const users = db.getAllUsers();
    assert.equal(saved, true, 'local synthetic data should save');
    assert.equal(Object.keys(users).length, totalUsers, 'all synthetic profiles should exist');
    assert.equal(users['synthetic-0'].stats.totalWorked, 1);
    assert.equal(users['synthetic-0'].stats.totalHarvested, 1);
    // Desde v1.1.0 el XP es aleatorio dentro de un rango acotado (nivel 0): work + harvest suman entre ambos rangos.
    // (En main 8a8d56a esta aserción esperaba 6 y ya fallaba: el XP fijo era 6 + 6 = 12.)
    const work = economy.xpRange('work');
    const harvest = economy.xpRange('harvest');
    assert.ok(
      users['synthetic-0'].xp >= work.min + harvest.min && users['synthetic-0'].xp <= work.max + harvest.max,
      'successful work and harvest should award XP inside their configured ranges',
    );
    assert.ok(users['synthetic-9999'].cash > 0);

    console.log(JSON.stringify({
      result: 'passed',
      environment: 'local synthetic run; no Discord or Neon requests',
      users: totalUsers,
      actions: totalUsers * 2,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      persistedFileBytes: fs.statSync(process.env.ECONOMY_DATA_FILE).size,
      note: 'This is not a production concurrency or capacity guarantee.',
    }, null, 2));
  } finally {
    await db.closeDB();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});