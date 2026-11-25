#!/usr/bin/env python3
"""Normalize Semgrep output into Maomao's trusted-check result contract."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

SEVERITY = {"ERROR": "high", "WARNING": "medium", "INFO": "low"}


def write(result):
    with open(os.environ["MAOMAO_RESULT_PATH"], "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
        handle.write("\n")


def main():
    repo = os.environ["MAOMAO_REPO_DIR"]
    trusted = os.environ.get("MAOMAO_TRUSTED_DIR", "")
    rules = os.path.join(trusted, "semgrep-rules")
    semgrep = shutil.which("semgrep")
    if not semgrep:
        write({"status": "error", "findings": [], "diagnostics": "semgrep binary is not installed in the scanner image/environment", "scanner": {"name": "semgrep"}})
        return 0
    if not os.path.isdir(rules):
        write({"status": "error", "findings": [], "diagnostics": "trusted semgrep-rules directory is missing from the pinned trusted-checks revision", "scanner": {"name": "semgrep"}})
        return 0
    version = subprocess.run([semgrep, "--version"], text=True, capture_output=True, timeout=15).stdout.strip() or "unknown"
    with tempfile.TemporaryDirectory() as temp:
        raw_path = os.path.join(temp, "semgrep.json")
        proc = subprocess.run(
            [semgrep, "scan", "--config", rules, "--json", "--output", raw_path, "--no-git-ignore", repo],
            text=True,
            capture_output=True,
            timeout=280,
        )
        try:
            with open(raw_path, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            write({"status": "error", "findings": [], "diagnostics": f"semgrep wrote no valid JSON: {exc}; stderr: {proc.stderr[-1000:]}", "scanner": {"name": "semgrep", "version": version}})
            return 0
    findings = []
    for item in payload.get("results", []):
        extra = item.get("extra") or {}
        severity = SEVERITY.get(str(extra.get("severity") or "").upper(), "medium")
        findings.append({
            "severity": severity,
            "category": item.get("check_id") or "semgrep",
            "file": item.get("path") or "unknown",
            "line": int((item.get("start") or {}).get("line") or 1),
            "summary": (extra.get("message") or item.get("check_id") or "semgrep finding")[:500],
            "evidence": (extra.get("lines") or "")[:1000],
        })
    errors = payload.get("errors") or []
    diagnostics = "\n".join(str(error.get("message") or error) for error in errors[:10]) or (proc.stderr[-2000:] if proc.returncode not in (0, 1) else "")
    write({
        "status": "failure" if findings else ("error" if proc.returncode not in (0, 1) and errors else "success"),
        "findings": findings,
        "diagnostics": diagnostics,
        "scanner": {"name": "semgrep", "version": version},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
