"""NDJSON helpers for pipeline phase streaming to the frontend."""

import json
from typing import Any


def ndjson_line(payload: dict[str, Any]) -> str:
    return json.dumps(payload, default=str) + "\n"
