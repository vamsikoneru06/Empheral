'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MockHypervisor, assertControlHost, OrchestratorError } = require('../src/index');

const refused = (err) => err instanceof OrchestratorError && err.code === 'control_host_refused' && err.httpStatus === 403;

test('control host: management addresses inside 172.16.0.0/16 are accepted', () => {
  for (const ip of ['172.16.0.1', '172.16.1.250', '172.16.255.254']) {
    assert.equal(assertControlHost(ip), ip);
  }
});

test('control host: anything outside 172.16.0.0/16 is refused, including exercise addresses', () => {
  for (const ip of ['172.17.0.1', '172.15.255.255', '10.40.1.10', '10.20.1.10', '10.10.30.10', '127.0.0.1', '192.168.1.5']) {
    assert.throws(() => assertControlHost(ip), refused, ip);
  }
});

test('control host: hostnames, IPv6 and malformed input are refused', () => {
  for (const host of ['mgmt.example', '::1', '172.16.1', '', undefined, null, 172]) {
    assert.throws(() => assertControlHost(host), refused, String(host));
  }
});

test('MockHypervisor refuses a non-management control host at construction', () => {
  assert.throws(() => new MockHypervisor({ controlHost: '10.40.1.10' }), refused);
  assert.throws(() => new MockHypervisor({ controlHost: 'jump.example' }), refused);
});

test('MockHypervisor defaults to the management switch address', () => {
  const hv = new MockHypervisor();
  assert.equal(hv.controlHost, '172.16.1.250');
});

test('no exercise-zone address can be used as a control target', async () => {
  const hv = new MockHypervisor();
  const target = { ip_address: '10.40.1.10', image_hash: 'a'.repeat(64), control_ip: '10.40.1.10' };
  await assert.rejects(() => hv.deploy(target), refused);
  await assert.rejects(() => hv.restore(target), refused);
  await assert.rejects(() => hv.hash(target), refused);
  assert.equal(hv.calls.length, 0, 'a refused call is never recorded as made');
});

test('MockHypervisor records calls and round-trips the golden hash', async () => {
  const hv = new MockHypervisor();
  const target = { ip_address: '10.40.2.20', image_hash: 'b'.repeat(64) };
  await hv.deploy(target, 'f'.repeat(64));
  assert.equal(await hv.hash(target), 'b'.repeat(64));
  hv.tamper('10.40.2.20', 'c'.repeat(64));
  assert.equal(await hv.hash(target), 'c'.repeat(64));
  await hv.restore(target);
  assert.equal(await hv.hash(target), 'b'.repeat(64));
  assert.deepEqual(hv.calls.map((c) => c.op), ['deploy', 'hash', 'hash', 'restore', 'hash']);
  assert.equal(hv.calls.every((c) => c.control === '172.16.1.250'), true);
  assert.equal(hv.injectedFlag('10.40.2.20'), 'f'.repeat(64));
});
