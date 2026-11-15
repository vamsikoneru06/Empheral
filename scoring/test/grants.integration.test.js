'use strict';

// Runs only when MYSQL_URL is set, with an admin account that may create databases and users.
// It applies the real db/001_init.sql to a scratch database and a scratch app user (names carry the
// process id), then checks that the app user can read and insert but cannot UPDATE or DELETE the
// append-only ledgers. The scratch database and user are dropped at the end. Nothing else is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MYSQL_URL = process.env.MYSQL_URL;
const SQL_FILE = path.join(__dirname, '..', '..', 'db', '001_init.sql');
const PASSWORD = 'scratch-only-' + process.pid;

test('append-only grants: app user cannot UPDATE or DELETE the ledgers', { skip: MYSQL_URL ? false : 'MYSQL_URL not set' }, async () => {
  const mysql = require('mysql2/promise');
  const suffix = `${process.pid}_${Date.now()}`;
  const dbName = `cr_grant_${suffix}`;
  const userName = `cr_app_${suffix}`;
  const adminUri = MYSQL_URL.replace(/\/[^/?]*(\?.*)?$/, '/$1');

  // Rename the schema's database and user to scratch names. The user name must be replaced first,
  // because it contains the database name as a prefix.
  const schema = fs
    .readFileSync(SQL_FILE, 'utf8')
    .replace(/'cyberrange_app'/g, `'${userName}'`)
    .replace(/CHANGE_ME_BEFORE_USE/g, PASSWORD)
    .replace(/\bcyberrange\b/g, dbName);

  const admin = await mysql.createConnection({ uri: adminUri, multipleStatements: true });
  let app = null;
  try {
    await admin.query(schema);

    app = await mysql.createConnection({ host: admin.config.host, port: admin.config.port, user: userName, password: PASSWORD, database: dbName });

    // Seed the parents first, so the INSERT that follows is judged on privilege, not on a foreign key.
    await admin.query(`INSERT INTO \`${dbName}\`.teams (id, name, pod_vlan, target_vlan, pod_subnet, target_subnet) VALUES (1, 'T1', 101, 201, '10.20.1.0/26', '10.40.1.0/26')`);
    await admin.query(`INSERT INTO \`${dbName}\`.rounds (id, name, status, image_set) VALUES (1, 'R1', 'planned', 'golden-v3')`);

    await app.query(`INSERT INTO score_events (round_id, team_id, kind, points, occurred_at) VALUES (1, 1, 'manual_adjust', 1, NOW(3))`);
    await assert.rejects(app.query('UPDATE score_events SET points = 999'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    await assert.rejects(app.query('DELETE FROM score_events'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });

    await app.query(`INSERT INTO audit_log (actor, action, subject, detail, occurred_at) VALUES ('t', 'x', NULL, NULL, NOW(3))`);
    await assert.rejects(app.query('UPDATE audit_log SET actor = "x"'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    await assert.rejects(app.query('DELETE FROM audit_log'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
  } finally {
    if (app) await app.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`DROP USER IF EXISTS '${userName}'@'%'`);
    await admin.end();
  }
});
