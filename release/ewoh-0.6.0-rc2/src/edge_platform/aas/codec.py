"""Minimal AAS/IEC 63278 JSON and AASX package codec.

Final 5.0 AA-07: EWOH must support AASX exchange and core submodel mapping
without requiring an external AAS SDK. This module implements a strict,
dependency-free subset of the AAS 3.0 JSON representation plus an AASX-like
OPC package container for import/export and partner delivery.
"""

from __future__ import annotations

import json
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

VALID_VALUE_TYPES = {
    "string",
    "integer",
    "number",
    "boolean",
    "dateTime",
    "json",
}


class AasCodecError(ValueError):
    """Raised when AAS JSON or AASX content violates the contract."""


@dataclass
class AasProperty:
    """One AAS submodel element property."""

    id_short: str
    value: Any
    value_type: str = "string"
    unit: str | None = None
    semantic_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "idShort": self.id_short,
            "value": self.value,
            "valueType": self.value_type,
            "unit": self.unit,
            "semanticId": self.semantic_id,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> AasProperty:
        if not isinstance(raw, dict) or not str(raw.get("idShort", "")).strip():
            raise AasCodecError("AAS property requires idShort")
        value_type = str(raw.get("valueType", "string"))
        if value_type not in VALID_VALUE_TYPES:
            raise AasCodecError(f"unsupported AAS valueType: {value_type}")
        return cls(
            id_short=str(raw["idShort"]),
            value=raw.get("value"),
            value_type=value_type,
            unit=raw.get("unit"),
            semantic_id=raw.get("semanticId"),
        )


@dataclass
class AasSubmodel:
    """One AAS submodel with typed properties."""

    id: str
    id_short: str
    properties: list[AasProperty] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "idShort": self.id_short,
            "elements": [property_.to_dict() for property_ in self.properties],
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> AasSubmodel:
        if not isinstance(raw, dict) or not str(raw.get("id", "")).strip():
            raise AasCodecError("AAS submodel requires id")
        elements = raw.get("elements", [])
        if not isinstance(elements, list):
            raise AasCodecError("AAS submodel elements must be a list")
        return cls(
            id=str(raw["id"]),
            id_short=str(raw.get("idShort", raw["id"])),
            properties=[AasProperty.from_dict(item) for item in elements],
        )


@dataclass
class AasAssetShell:
    """AAS shell with asset identity and submodels."""

    asset_id: str
    id_short: str
    submodels: list[AasSubmodel] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "assetId": self.asset_id,
            "idShort": self.id_short,
            "submodels": [submodel.to_dict() for submodel in self.submodels],
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> AasAssetShell:
        if not isinstance(raw, dict):
            raise AasCodecError("AAS document must be an object")
        asset_id = str(
            raw.get("assetId")
            or raw.get("id")
            or (raw.get("assetInformation") or {}).get("globalAssetId")
            or ""
        ).strip()
        if not asset_id:
            raise AasCodecError("AAS shell requires assetId")
        id_short = str(raw.get("idShort") or asset_id)
        submodels = raw.get("submodels", [])
        if not isinstance(submodels, list):
            raise AasCodecError("AAS submodels must be a list")
        return cls(
            asset_id=asset_id,
            id_short=id_short,
            submodels=[AasSubmodel.from_dict(item) for item in submodels],
        )


def parse_aas_json(document: dict[str, Any]) -> AasAssetShell:
    """Parse a canonical AAS JSON document."""
    return AasAssetShell.from_dict(document)


def to_aas_json(shell: AasAssetShell) -> dict[str, Any]:
    """Serialize an AAS shell to canonical JSON."""
    if not isinstance(shell, AasAssetShell):
        raise AasCodecError("to_aas_json expects AasAssetShell")
    return shell.to_dict()


def aas_to_twin_semantics(shell: AasAssetShell) -> dict[str, Any]:
    """Map an AAS shell to EWOH twin semantic properties."""
    return {
        "assetId": shell.asset_id,
        "idShort": shell.id_short,
        "semantics": [submodel.id_short for submodel in shell.submodels],
        "submodels": [
            {
                "id": submodel.id,
                "idShort": submodel.id_short,
                "properties": [
                    {
                        "name": property_.id_short,
                        "value": property_.value,
                        "valueType": property_.value_type,
                        "unit": property_.unit,
                        "semanticId": property_.semantic_id,
                    }
                    for property_ in submodel.properties
                ],
            }
            for submodel in shell.submodels
        ],
    }


def twin_to_aas(
    asset_id: str,
    id_short: str,
    submodels: list[dict[str, Any]],
) -> AasAssetShell:
    """Build an AAS shell from EWOH twin semantic dictionaries."""
    parsed = AasAssetShell.from_dict(
        {
            "assetId": asset_id,
            "idShort": id_short,
            "submodels": submodels,
        }
    )
    return parsed


def pack_aasx(shell: AasAssetShell, output_path: str | Path) -> Path:
    """Write an AASX-like OPC package containing the canonical AAS JSON."""
    target = Path(output_path)
    if target.exists():
        raise AasCodecError(f"AASX output already exists: {target}")
    document = to_aas_json(shell)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/vnd.aasx")
        archive.writestr(
            "aasx/aas.json",
            json.dumps(document, ensure_ascii=False, indent=2),
        )
        archive.writestr("aasx/origin", "EWOH AASX exchange package v1")
        archive.writestr(
            "aasx/manifest.json",
            json.dumps(
                {
                    "format": "AASX-like",
                    "standard": "IEC 63278 / AAS 3.0 JSON subset",
                    "assetId": shell.asset_id,
                    "submodelCount": len(shell.submodels),
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
    return target


def unpack_aasx(input_path: str | Path) -> AasAssetShell:
    """Read an AASX-like package and return the AAS shell."""
    source = Path(input_path)
    if not source.is_file():
        raise AasCodecError(f"AASX file not found: {source}")
    with zipfile.ZipFile(source, "r") as archive:
        names = archive.namelist()
        if "aasx/aas.json" not in names:
            raise AasCodecError("AASX package is missing aasx/aas.json")
        try:
            document = json.loads(archive.read("aasx/aas.json").decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise AasCodecError(f"invalid AAS JSON in package: {exc}") from exc
    if not isinstance(document, dict):
        raise AasCodecError("AASX aas.json must contain an object")
    return AasAssetShell.from_dict(document)


def redact_aas(document: dict[str, Any]) -> dict[str, Any]:
    """Return a deep copy with secret-like property values redacted."""
    if isinstance(document, dict):
        id_short = str(document.get("idShort", "")).lower()
        if any(
            token in id_short
            for token in ("password", "secret", "token", "apikey", "credential")
        ) and "value" in document:
            result = dict(document)
            result["value"] = "[REDACTED]"
            return result
    result: dict[str, Any] = {}
    for key, value in document.items():
        if isinstance(value, dict):
            result[key] = redact_aas(value)
        elif isinstance(value, list):
            result[key] = [redact_aas(item) if isinstance(item, dict) else item for item in value]
        elif isinstance(value, str) and any(
            token in value.lower() for token in ("password", "secret", "token", "apikey", "credential")
        ):
            result[key] = "[REDACTED]"
        else:
            result[key] = value
    return result
