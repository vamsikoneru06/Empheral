"""Shared error type. Any problem with the inputs (not with the network) raises ConfigError."""


class ConfigError(Exception):
    """A config file or expected matrix is missing, malformed or inconsistent. CLI exit code 2."""
