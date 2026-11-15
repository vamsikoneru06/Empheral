// The checkpoint's rules, read from the compiled config. This logic agrees with the verifier on all 396 cases.
import raw from './data.json';
import type { DemoData, Probe } from './types';

export const D = raw as unknown as DemoData;

interface AddrSpec { any?: true; net?: number; wild?: number }
export interface Rule { seq: string; action: string; proto: string; src: AddrSpec; dst: AddrSpec; established: boolean; text: string }
export interface Decision { permit: boolean; acl: string; rule: Rule | null }

const ipn = (s: string) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);

function parseRule(text: string): Rule {
  const t = text.trim().split(/\s+/);
  let i = 3;
  const spec = (): AddrSpec => {
    if (t[i] === 'any') { i += 1; return { any: true }; }
    const r = { net: ipn(t[i]), wild: ipn(t[i + 1]) };
    i += 2;
    return r;
  };
  const src = spec();
  const dst = spec();
  return { seq: t[0], action: t[1], proto: t[2], src, dst, established: t.includes('established'), text: text.trim() };
}

const matches = (spec: AddrSpec, ip: number) =>
  spec.any === true || (((ip ^ (spec.net as number)) & ~(spec.wild as number)) >>> 0) === 0;

const ACL: Record<string, Rule[]> = Object.fromEntries(Object.entries(D.acl).map(([name, lines]) => [name, lines.map(parseRule)]));

const PACKET: Record<Probe, { proto: string; ack: boolean }> = {
  icmp: { proto: 'icmp', ack: false },
  'tcp-syn': { proto: 'tcp', ack: false },
  'tcp-ack': { proto: 'tcp', ack: true },
  udp: { proto: 'udp', ack: false },
};

/** First matching line of the sender's ingress list decides; no match means the implicit deny. */
export function evaluate(src: string, dst: string, probe: Probe): Decision {
  const acl = D.aclFor[src];
  const s = ipn(D.seg[src].ip);
  const d = ipn(D.seg[dst].ip);
  const pk = PACKET[probe];
  for (const r of ACL[acl]) {
    if (r.proto !== 'ip' && r.proto !== pk.proto) continue;
    if (r.established && !(pk.proto === 'tcp' && pk.ack)) continue;
    if (matches(r.src, s) && matches(r.dst, d)) return { permit: r.action === 'permit', acl, rule: r };
  }
  return { permit: false, acl, rule: null };
}

export const ruleText = (ev: Decision) =>
  ev.rule ? `${ev.acl} line ${ev.rule.seq}: ${ev.rule.text}` : `${ev.acl}: no line matched, so it is blocked`;

export const teamOf = (n: string) => /^(pod|target)-(\d)$/.exec(n)?.[2] ?? null;

export function label(n: string): string {
  const m = /^(pod|target)-(\d)$/.exec(n);
  if (m) return `Team ${m[2]} ${m[1] === 'pod' ? 'workstations' : 'targets'}`;
  const named: Record<string, string> = {
    scoring: 'Scoring server',
    'institutional-a': 'College network A',
    'institutional-b': 'College network B',
    management: 'Management network',
  };
  return named[n] ?? n;
}

export function shortLabel(n: string): string {
  const m = /^(pod|target)-(\d)$/.exec(n);
  if (m) return `T${m[2]} ${m[1] === 'pod' ? 'work' : 'target'}`;
  const named: Record<string, string> = { scoring: 'Scoring', 'institutional-a': 'College A', 'institutional-b': 'College B', management: 'Mgmt' };
  return named[n] ?? n;
}

export const PROBE_NAME: Record<Probe, string> = {
  icmp: 'Ping',
  'tcp-syn': 'Start a connection (TCP SYN)',
  'tcp-ack': 'Reply on a connection (TCP ACK)',
  udp: 'UDP message',
};

export const CHECK_NAME: Record<string, string> = {
  team_to_team_denied: 'No team can reach another team',
  target_to_scoring_denied: 'Targets can answer the scoring server but never start a connection to it',
  scoring_to_target_permitted: 'The scoring server reaches every target',
  exercise_to_institutional_denied: 'Nothing in the range reaches the college network',
  mgmt_plane_unreachable: 'Nothing in the range reaches the management network',
  mgmt_acl_counter_zero: 'The management block rules were never hit',
  environments_identical: 'Every team gets an identical set of targets',
};
