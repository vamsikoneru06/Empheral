'use strict';

const net = require('node:net');
const { OrchestratorError } = require('./errors');

const MANAGEMENT_BASE = '172.16.0.0';
const MANAGEMENT_PREFIX = 16;
const DEFAULT_CONTROL_HOST = '172.16.1.250';

function ipToInt(ip) {
  const o = ip.split('.').map(Number);
  return o[0] * 2 ** 24 + o[1] * 2 ** 16 + o[2] * 2 ** 8 + o[3];
}

function inCidr(ip, base, prefix) {
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
}

/**
 * Hard rule (P3, CLAUDE.md rule 1): control traffic only leaves toward 172.16.0.0/16.
 * Exercise addresses (10.20/16, 10.40/16) are outside that block, so they are refused
 * here too. Hostnames are refused because they could resolve anywhere.
 */
function assertControlHost(address) {
  if (typeof address !== 'string' || net.isIPv4(address) !== true) {
    throw new OrchestratorError(
      'control_host_refused',
      `control host "${address}" must be an IPv4 address inside 172.16.0.0/16`,
      403,
    );
  }
  if (!inCidr(address, MANAGEMENT_BASE, MANAGEMENT_PREFIX)) {
    throw new OrchestratorError(
      'control_host_refused',
      `control host ${address} is outside the management plane 172.16.0.0/16`,
      403,
    );
  }
  return address;
}

/**
 * Default driver. Free, in memory, records every call. It is the interface a real
 * hypervisor driver would implement:
 *   deploy(target, flag)  write the golden image and inject the flag
 *   restore(target)       return the target to the golden baseline
 *   hash(target)          sha256 of the target's base disk, or null if unknown
 * target.control_ip (optional) is the address used for control. It falls back to
 * controlHost, and it must pass assertControlHost.
 */
class MockHypervisor {
  constructor({ controlHost = DEFAULT_CONTROL_HOST } = {}) {
    this.controlHost = assertControlHost(controlHost);
    this.calls = [];
    this._disks = new Map();
    this._flags = new Map();
  }

  _control(op, target) {
    const control = assertControlHost(target.control_ip ?? this.controlHost);
    this.calls.push({ op, ip_address: target.ip_address, control });
    return control;
  }

  async deploy(target, flag = null) {
    this._control('deploy', target);
    this._disks.set(target.ip_address, target.image_hash);
    this._flags.set(target.ip_address, flag);
  }

  async restore(target) {
    this._control('restore', target);
    this._disks.set(target.ip_address, target.image_hash);
  }

  async hash(target) {
    this._control('hash', target);
    return this._disks.get(target.ip_address) ?? null;
  }

  /** Test helper: simulate drift on a target's disk. */
  tamper(ip, hash) {
    this._disks.set(ip, hash);
  }

  /** Test helper: the flag last injected on a target. */
  injectedFlag(ip) {
    return this._flags.get(ip) ?? null;
  }
}

module.exports = { MockHypervisor, assertControlHost, DEFAULT_CONTROL_HOST };
