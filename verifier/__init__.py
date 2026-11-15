"""CyberRange-Net containment verifier (C2).

Reads the compiled IOS in out/*.cfg, evaluates every probe in the expected matrix through the
config model, and diffs the result against out/expected-matrix.json. Config-level evaluation only.
"""
