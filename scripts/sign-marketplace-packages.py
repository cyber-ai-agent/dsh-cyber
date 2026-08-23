"""Refresh local marketplace file hashes and official content digests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "marketplace"


def stable_serialize(value: object) -> str:
    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(stable_serialize(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + stable_serialize(value[key])
            for key in sorted(value)
        ) + "}"
    raise TypeError(f"Unsupported value: {type(value)!r}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


for manifest_path in sorted(ROOT.glob("*/*/dsh-cyber.package.json")):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    package_root = manifest_path.parent
    for file in manifest["files"]:
        file["sha256"] = sha256(package_root / file["path"])
    certification = manifest.get("certification")
    if certification:
        unsigned = {**manifest, "certification": {
            "authority": certification["authority"],
            "level": certification["level"],
        }}
        certification["contentSha256"] = hashlib.sha256(
            stable_serialize(unsigned).encode("utf-8")
        ).hexdigest()
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(manifest_path.relative_to(ROOT.parent))
