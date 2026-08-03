"""Connector runtime for versioned EWOH connector packages.

This module implements the Final 5.0 connector SDK surface that is testable
without external infrastructure: manifest loading/validation, config
validation, health checks, secret redaction, and lifecycle state. Real
protocol drivers are out of scope for this module; they are implemented as
edge adapters behind the same manifest contract.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+")
SECRET_KEY_PATTERN = re.compile(
    r"password|secret|token|api[_-]?key|private[_-]?key|credential",
    re.IGNORECASE,
)

REQUIRED_MANIFEST_FIELDS = (
    "id",
    "version",
    "runtime",
    "protocol",
    "outputEvents",
    "configSchema",
    "compatibility",
    "permissions",
    "tck",
    "sbom",
    "rollback",
)


class ConnectorManifestError(ValueError):
    """Raised when a connector manifest violates the package contract."""


@dataclass
class ConnectorManifest:
    """Validated connector manifest."""

    id: str
    version: str
    runtime: str
    protocol: str
    output_events: list[str]
    config_schema: dict[str, Any]
    compatibility: dict[str, Any]
    permissions: dict[str, Any]
    tck: str
    sbom: str
    rollback: str
    input_profile: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> ConnectorManifest:
        missing = [key for key in REQUIRED_MANIFEST_FIELDS if key not in raw]
        if missing:
            raise ConnectorManifestError(
                f"manifest missing required fields: {', '.join(missing)}"
            )
        if not SEMVER_PATTERN.match(str(raw["version"])):
            raise ConnectorManifestError("version must be semver-like")
        if not isinstance(raw.get("outputEvents"), list) or not raw["outputEvents"]:
            raise ConnectorManifestError("outputEvents must be a non-empty list")
        if not isinstance(raw.get("configSchema"), dict):
            raise ConnectorManifestError("configSchema must be an object")
        if not isinstance(raw.get("compatibility"), dict):
            raise ConnectorManifestError("compatibility must be an object")
        return cls(
            id=str(raw["id"]),
            version=str(raw["version"]),
            runtime=str(raw["runtime"]),
            protocol=str(raw["protocol"]),
            output_events=[str(event) for event in raw["outputEvents"]],
            config_schema=dict(raw["configSchema"]),
            compatibility=dict(raw["compatibility"]),
            permissions=dict(raw.get("permissions", {})),
            tck=str(raw["tck"]),
            sbom=str(raw["sbom"]),
            rollback=str(raw["rollback"]),
            input_profile=raw.get("inputProfile"),
            raw=dict(raw),
        )


def load_manifest(path: Path) -> ConnectorManifest:
    """Load and validate a connector manifest JSON file."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConnectorManifestError(f"cannot load manifest {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConnectorManifestError("manifest root must be an object")
    return ConnectorManifest.from_dict(raw)


def discover_manifests(directory: Path) -> list[ConnectorManifest]:
    """Load every *.json manifest in a directory, sorted by id/version."""
    manifests = []
    for path in sorted(Path(directory).glob("*.json")):
        manifests.append(load_manifest(path))
    return manifests


def validate_config(manifest: ConnectorManifest, config: dict[str, Any]) -> None:
    """Validate connector config against the manifest config schema."""
    required = manifest.config_schema.get("required", [])
    if not isinstance(required, list):
        raise ConnectorManifestError("configSchema.required must be a list")
    missing = [key for key in required if key not in config]
    if missing:
        raise ConnectorManifestError(
            f"connector {manifest.id} config missing: {', '.join(missing)}"
        )


def healthcheck(manifest: ConnectorManifest, config: dict[str, Any]) -> dict[str, Any]:
    """Return connector health without opening a real network connection."""
    reasons = []
    try:
        validate_config(manifest, config)
    except ConnectorManifestError as exc:
        reasons.append(str(exc))
    if manifest.protocol == "mqtt" and not config.get("brokerUrl"):
        reasons.append("brokerUrl missing for mqtt connector")
    if manifest.protocol == "exo-jsonl" and not config.get("deviceId"):
        reasons.append("deviceId missing for exo-jsonl connector")
    return {
        "id": manifest.id,
        "version": manifest.version,
        "protocol": manifest.protocol,
        "runtime": manifest.runtime,
        "status": "degraded" if reasons else "ok",
        "reasons": reasons,
        "outputEvents": manifest.output_events,
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def redact_config(config: dict[str, Any]) -> dict[str, Any]:
    """Return a deep copy with secret-like keys redacted."""
    result: dict[str, Any] = {}
    for key, value in config.items():
        if SECRET_KEY_PATTERN.search(key):
            result[key] = "[REDACTED]"
        elif isinstance(value, dict):
            result[key] = redact_config(value)
        elif isinstance(value, list):
            result[key] = [
                redact_config(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            result[key] = value
    return result


class Connector:
    """Lifecycle wrapper around a validated connector manifest."""

    def __init__(
        self,
        manifest: ConnectorManifest,
        config: dict[str, Any] | None = None,
    ):
        validate_config(manifest, config or {})
        self.manifest = manifest
        self.config = dict(config or {})
        self._running = False
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            self._running = True

    def stop(self) -> None:
        with self._lock:
            self._running = False

    @property
    def is_running(self) -> bool:
        return self._running

    def health(self) -> dict[str, Any]:
        report = healthcheck(self.manifest, self.config)
        report["running"] = self.is_running
        return report

    def redacted_config(self) -> dict[str, Any]:
        return redact_config(self.config)
