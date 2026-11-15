export type Verdict = 'permit' | 'deny';
export type Probe = 'icmp' | 'tcp-syn' | 'tcp-ack' | 'udp';

export interface Segment {
  ip: string;
  cidr: string;
  kind: string;
  vlan: number | null;
}

export interface CheckSummary {
  passed: boolean;
  violations: number;
  trunk_violations: number;
  failing: string[];
}

export interface Tamper extends CheckSummary {
  change: string;
}

/** One simulator attempt: step, target IP, segment, probe, port, result, blocking rule. */
export type Attempt = [string, string, string, Probe, number | null, string, string | null];

export interface DemoData {
  generated: string;
  sources: string[];
  dests: string[];
  probes: Probe[];
  seg: Record<string, Segment>;
  matrix: Record<string, Record<string, Record<Probe, Verdict>>>;
  assertions: Record<string, boolean | string>;
  pairs: number;
  probeCount: number;
  violations: number;
  acl: Record<string, string[]>;
  aclFor: Record<string, string>;
  baseline: CheckSummary;
  mutants: Tamper[];
  run: {
    compromised: { ip: string; segment: string };
    passed: boolean;
    steps: { step: string; name: string; passed: boolean }[];
    attempts: Attempt[];
    refused: string;
    refusedCode: number;
  };
}
