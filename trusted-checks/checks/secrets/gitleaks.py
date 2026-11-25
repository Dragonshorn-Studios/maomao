#!/usr/bin/env python3
"""Normalize Gitleaks output into Maomao's trusted-check result contract."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile


def write(result):
    with open(os.environ["MAOMAO_RESULT_PATH"], "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
        handle.write("\n")


def main():
    repo = os.environ["MAOMAO_REPO_DIR"]
    gitleaks = shutil.which("gitleaks")
    if not gitleaks:
        write({
            "status": "error",
            "findings": [],
            "diagnostics": "gitleaks binary is not installed in the scanner image/environment",
            "scanner": {"name": "gitleaks"},
        })
        return 0
    version = subprocess.run([gitleaks, "version"], text=True, capture_output=True, timeout=15).stdout.strip() or "unknown"
    with tempfile.TemporaryDirectory() as temp:
        raw_path = os.path.join(temp, "gitleaks.json")
        proc = subprocess.run(
            [gitleaks, "dir", repo, "--report-format", "json", "--report-path", raw_path, "--exit-code", "0", "--no-banner"],
            text=True,
            capture_output=True,
            timeout=110,
        )
        try:
            with open(raw_path, encoding="utf-8") as handle:
                entries = json.load(handle)
        except FileNotFoundError:
            entries = []
        except json.JSONDecodeError as exc:
            write({
                "status": "error",
                "findings": [],
                "diagnostics": f"gitleaks wrote invalid JSON: {exc}; stderr: {proc.stderr[-1000:]}",
                "scanner": {"name": "gitleaks", "version": version},
            })
            return 0
    findings = []
    for item in entries if isinstance(entries, list) else []:
        secret = str(item.get("Secret") or "")
        fingerprint = hashlib.sha256(secret.encode()).hexdigest()[:16] if secret else "unavailable"
        findings.append({
            "severity": "high",
            "category": "secret",
            "file": item.get("File") or item.get("file") or "unknown",
            "line": int(item.get("StartLine") or item.get("line") or 1),
            "summary": f"{item.get('RuleID') or item.get('rule') or 'secret'} credential detected",
            "evidence": f"Secret value redacted; sha256 fingerprint {fingerprint}",
            # The runner consumes this field to redact every occurrence before persistence.
            "secret": secret,
        })
    write({
        "status": "failure" if findings else "success",
        "findings": findings,
        "diagnostics": proc.stderr[-2000:] if proc.returncode not in (0, 1) else "",
        "scanner": {"name": "gitleaks", "version": version},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
