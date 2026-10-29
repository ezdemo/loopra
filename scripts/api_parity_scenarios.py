"""Exercise reversible API scenarios against two disposable parity fixtures.

Uses the same environment as api_parity_probe.py. Requires
LOOPRA_PARITY_ALLOW_MUTATIONS=isolated-fixtures. Never use real user homes.
Creates and removes its own session, future requirement and disabled schedule.
Does not invoke models, update installers, native pickers or desktop apps.
"""

import csv
import json
import os
import sys
import time
import uuid
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def request(side, method, path, body=None):
    req = Request(
        os.environ[f"LOOPRA_PARITY_{side}_URL"].rstrip("/") + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method, headers={
            "X-Loopra-Key": os.environ[f"LOOPRA_PARITY_{side}_KEY"],
            "Content-Type": "application/json",
        },
    )
    try:
        response = urlopen(req, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


def normalize(value):
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()
                if key not in {"id", "sessionName", "createdAt", "updatedAt", "nextRunAt"}}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def main():
    if os.environ.get("LOOPRA_PARITY_ALLOW_MUTATIONS") != "isolated-fixtures":
        raise SystemExit("Only run with isolated disposable fixtures; set LOOPRA_PARITY_ALLOW_MUTATIONS=isolated-fixtures")
    name = "parity-" + uuid.uuid4().hex[:12]
    workspace = os.environ["LOOPRA_PARITY_WORKSPACE"]
    scheduled_at = int(time.time() * 1000) + 86400000
    query = "?" + urlencode({"workspaceHash": workspace, "sessionName": name})
    records = {}
    for side in ("JAVA", "GO"):
        captures, cleanup = {}, []

        def capture(label, method, path, body=None):
            code, payload = request(side, method, path, body)
            captures[label] = (code, normalize(payload))
            return payload.get("data")

        try:
            capture("metadata.commands", "GET", "/api/agent/commands")
            capture("metadata.skills", "GET", "/api/agent/skills")
            capture("session.create", "POST", "/api/sessions/new" + query)
            cleanup.append(("/api/sessions/" + name + query, None))
            capture("session.current", "GET", "/api/sessions/current" + query)
            capture("session.title", "PUT", "/api/sessions/" + name + "/title" + query, {"title": "  Contract title  "})
            capture("session.settings", "GET", "/api/sessions/" + name + "/settings" + query)
            capture("session.invalid-channel", "PUT", "/api/sessions/" + name + "/settings" + query,
                    {"modelChannelId": "parity-missing"})
            capture("session.worktree", "PUT", "/api/sessions/" + name + "/worktree" + query, {"worktreeMode": False, "mergeMode": "ai-auto"})
            capture("mode.enable", "POST", "/api/agent/mode", {"workspaceHash": workspace, "sessionName": name, "enabled": True})
            capture("mode.disable", "POST", "/api/agent/mode", {"workspaceHash": workspace, "sessionName": name, "enabled": False})
            for config_id, value in (("effort", "low"), ("fast", "on"), ("plan", "on")):
                capture("engine." + config_id, "PUT", "/api/agent-engines/config", {
                    "workspaceHash": workspace, "sessionName": name, "configId": config_id, "value": value,
                })
            capture("engine.invalid", "PUT", "/api/agent-engines/config", {
                "workspaceHash": workspace, "sessionName": name, "configId": "mode", "value": "invalid",
            })
            item = capture("requirement.create", "POST", "/api/requirements", {
                "title": "Parity fixture", "description": "Never run this fixture",
                "priority": "medium", "projectHash": workspace, "scheduleMode": "scheduled",
                "scheduledAt": scheduled_at,
            })
            if item and "id" in item:
                cleanup.append(("/api/requirements/" + item["id"], None))
                capture("requirement.update", "PUT", "/api/requirements/" + item["id"],
                        {"description": "Updated", "priority": "low"})
                capture("requirement.partial-update", "PUT", "/api/requirements/" + item["id"],
                        {"priority": "medium"})
            capture("requirement.invalid-title", "POST", "/api/requirements", {"projectHash": workspace})
            capture("requirement.invalid-project", "POST", "/api/requirements", {"title": "Invalid"})
            capture("requirement.missing-run", "POST", "/api/requirements/parity-missing/run", {})
            task = capture("schedule.create", "POST", "/api/schedules" + query, {
                "name": "Parity disabled schedule", "message": "Never run this fixture",
                "sessionName": name, "sessionMode": "existing", "intervalSec": 3600, "enabled": False,
            })
            if task and "id" in task:
                cleanup.append(("/api/schedules/" + task["id"] + query, None))
                capture("schedule.read", "GET", "/api/schedules/" + task["id"] + query)
                capture("schedule.partial-update", "PUT", "/api/schedules/" + task["id"] + query,
                        {"name": "Renamed schedule"})
            default_task = capture("schedule.default-disabled", "POST", "/api/schedules" + query, {
                "message": "Default state fixture", "sessionName": name, "intervalSec": 3600,
            })
            if default_task and "id" in default_task:
                cleanup.append(("/api/schedules/" + default_task["id"] + query, None))
            capture("schedule.invalid-message", "POST", "/api/schedules" + query, {"intervalSec": 1})
            capture("schedule.invalid-interval", "POST", "/api/schedules" + query,
                    {"message": "Invalid", "sessionName": name, "intervalSec": 0})
            capture("schedule.missing-read", "GET", "/api/schedules/parity-missing" + query)
            capture("history.empty", "GET", "/api/agent/history" + query)
            capture("elicitation.empty", "GET", "/api/chat/elicitations" + query)
        finally:
            for path, body in reversed(cleanup):
                request(side, "DELETE", path, body)
        records[side] = captures
    rows = []
    for label, java in records["JAVA"].items():
        go = records["GO"][label]
        same = java == go
        rows.append({"Scenario": label, "Equal": same,
                     "Java": json.dumps(java, ensure_ascii=True, sort_keys=True),
                     "Go": json.dumps(go, ensure_ascii=True, sort_keys=True)})
        print(f"{'MATCH' if same else 'DIFF '} {label}")
    output = sys.argv[1] if len(sys.argv) > 1 else "api-parity-scenarios.csv"
    with open(output, "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"{sum(row['Equal'] for row in rows)}/{len(rows)} normalized scenario responses match")


if __name__ == "__main__":
    main()
