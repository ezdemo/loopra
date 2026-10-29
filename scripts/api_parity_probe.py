"""Compare read-only API response shapes of isolated Java and Go fixtures.

Set LOOPRA_PARITY_JAVA_URL, LOOPRA_PARITY_GO_URL, LOOPRA_PARITY_JAVA_KEY,
LOOPRA_PARITY_GO_KEY and LOOPRA_PARITY_WORKSPACE. Optional output: argv[1].
Only status codes and field shapes are written; payloads and keys are omitted.
"""

import csv
import json
import os
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PATHS = (
    "/api/config", "/api/models", "/api/workspace", "/api/workspaces",
    "/api/workspaces/order", "/api/agent/status", "/api/agent/session-status",
    "/api/agent/mode", "/api/agent/acp-state", "/api/agent/project-capabilities",
    "/api/agent/commands", "/api/agent/skills",
    "/api/agent-engines/preferences", "/api/agent-engines/session",
    "/api/agent-engines/config", "/api/sessions/current", "/api/sessions/stats",
    "/api/mcp/export", "/api/mcp/tunnel", "/api/usage", "/api/version/update",
    "/api/pets/active", "/api/openapi/sources", "/api/skill-market/markets",
    "/api/prompt-presets", "/api/snapshots/status",
)


def shape(value):
    if isinstance(value, dict):
        return {key: shape(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        # Array length and sample data do not establish contract differences.
        return ["array"] + sorted({json.dumps(shape(item), sort_keys=True) for item in value})
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (float, int)):
        return "number"
    return "string"


def request(side, path):
    url = os.environ[f"LOOPRA_PARITY_{side}_URL"].rstrip("/") + path
    query = urlencode({
        "workspaceHash": os.environ["LOOPRA_PARITY_WORKSPACE"],
        "sessionName": os.environ.get("LOOPRA_PARITY_SESSION", "parity-probe"),
        "agentId": "native",
    })
    req = Request(url + "?" + query, headers={
        "X-Loopra-Key": os.environ[f"LOOPRA_PARITY_{side}_KEY"],
    })
    try:
        response = urlopen(req, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        payload = json.load(response)
        return response.status, shape(payload)


def main():
    rows = []
    for path in PATHS:
        java_status, java_shape = request("JAVA", path)
        go_status, go_shape = request("GO", path)
        same = java_status == go_status and java_shape == go_shape
        rows.append({
            "Path": path, "JavaStatus": java_status, "GoStatus": go_status,
            "SameShape": same, "JavaShape": json.dumps(java_shape, ensure_ascii=True),
            "GoShape": json.dumps(go_shape, ensure_ascii=True),
        })
        print(f"{'MATCH' if same else 'DIFF '} {path}")
    output = sys.argv[1] if len(sys.argv) > 1 else "api-parity-shapes.csv"
    with open(output, "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"{sum(row['SameShape'] for row in rows)}/{len(rows)} recursive response shapes match")


if __name__ == "__main__":
    main()
