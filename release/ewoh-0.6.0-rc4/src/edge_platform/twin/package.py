"""Twin package manifest/runtime for digital twin assets.

Final 5.0 Y2-09: twin packages must be versioned, calibrated, and auditable
like every other EWOH asset. This module validates twin manifests and checks
calibration readiness without external CAD/3D tooling.
"""

from __future__ import annotations

import json
import re
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
    "modelFormat",
    "coordinateSystem",
    "unit",
    "calibration",
    "semantics",
    "compatibility",
    "tck",
    "sbom",
    "rollback",
)


class TwinPackageManifestError(ValueError):
    """Raised when a twin package violates the manifest contract."""


@dataclass
class TwinPackageManifest:
    id: str
    version: str
    model_format: str
    coordinate_system: str
    unit: str
    calibration: dict[str, Any]
    semantics: list[str]
    compatibility: dict[str, Any]
    tck: str
    sbom: str
    rollback: str
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> TwinPackageManifest:
        missing = [key for key in REQUIRED_MANIFEST_FIELDS if key not in raw]
        if missing:
            raise TwinPackageManifestError(
                f"manifest missing required fields: {', '.join(missing)}"
            )
        if not SEMVER_PATTERN.match(str(raw["version"])):
            raise TwinPackageManifestError("version must be semver-like")
        if not isinstance(raw.get("semantics"), list) or not raw["semantics"]:
            raise TwinPackageManifestError("semantics must be a non-empty list")
        if not isinstance(raw.get("calibration"), dict):
            raise TwinPackageManifestError("calibration must be an object")
        return cls(
            id=str(raw["id"]),
            version=str(raw["version"]),
            model_format=str(raw["modelFormat"]),
            coordinate_system=str(raw["coordinateSystem"]),
            unit=str(raw["unit"]),
            calibration=dict(raw["calibration"]),
            semantics=[str(item) for item in raw["semantics"]],
            compatibility=dict(raw["compatibility"]),
            tck=str(raw["tck"]),
            sbom=str(raw["sbom"]),
            rollback=str(raw["rollback"]),
            raw=dict(raw),
        )


def load_manifest(path: Path) -> TwinPackageManifest:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TwinPackageManifestError(f"cannot load manifest {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise TwinPackageManifestError("manifest root must be an object")
    return TwinPackageManifest.from_dict(raw)


def discover_manifests(directory: Path) -> list[TwinPackageManifest]:
    manifests = []
    for path in sorted(Path(directory).glob("*.json")):
        manifests.append(load_manifest(path))
    return manifests


def validate_calibration(
    manifest: TwinPackageManifest,
    calibration: dict[str, Any],
) -> None:
    required = manifest.calibration.get("required", [])
    if not isinstance(required, list):
        raise TwinPackageManifestError("calibration.required must be a list")
    missing = [key for key in required if key not in calibration]
    if missing:
        raise TwinPackageManifestError(
            f"twin {manifest.id} calibration missing: {', '.join(missing)}"
        )


def healthcheck(
    manifest: TwinPackageManifest,
    calibration: dict[str, Any],
) -> dict[str, Any]:
    reasons = []
    try:
        validate_calibration(manifest, calibration)
    except TwinPackageManifestError as exc:
        reasons.append(str(exc))
    if manifest.calibration.get("status") == "pending" and not calibration:
        reasons.append("calibration pending")
    return {
        "id": manifest.id,
        "version": manifest.version,
        "modelFormat": manifest.model_format,
        "coordinateSystem": manifest.coordinate_system,
        "unit": manifest.unit,
        "status": "degraded" if reasons else "ok",
        "reasons": reasons,
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def redact_calibration(calibration: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in calibration.items():
        if SECRET_KEY_PATTERN.search(key):
            result[key] = "[REDACTED]"
        elif isinstance(value, dict):
            result[key] = redact_calibration(value)
        elif isinstance(value, list):
            result[key] = [
                redact_calibration(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            result[key] = value
    return result
