'use strict';

// Store factories. Both return an object with the same method names.
// There is no update or delete method for score_events or audit_log in either store.
const { createMemoryStore } = require('./memory');
const { createMysqlStore } = require('./mysql');

module.exports = { createMemoryStore, createMysqlStore };
