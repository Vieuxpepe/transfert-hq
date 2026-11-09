import re
from pathlib import Path

bridge_path = Path(r"C:\Transfert\iphone_bridge.py")
content = bridge_path.read_text(encoding="utf-8")
crlf = "\r\n" in content
content = content.replace("\r\n", "\n")

# 1. Add .gif to ASSET_CONTENT_TYPES
if '".gif"' not in content:
    content = content.replace(
        '".webp": "image/webp",\n',
        '".webp": "image/webp",\n    ".gif": "image/gif",\n'
    )

# 2. Add content_disposition BEFORE class Handler
helper = '''def content_disposition(disposition: str, filename: str) -> str:
    """Build a Latin-1 safe Content-Disposition value with UTF-8 filename* extension."""
    clean_name = str(filename or "file").replace("\\r", "").replace("\\n", "")
    ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", clean_name) or "file"
    encoded = quote(clean_name)
    return f"{disposition}; filename=\\"{ascii_name}\\"; filename*=UTF-8''{encoded}"


class Handler(BaseHTTPRequestHandler):'''

if "def content_disposition(" not in content:
    content = content.replace("class Handler(BaseHTTPRequestHandler):", helper)

content = re.sub(
    r'(\s+disp = "attachment" if force_attach else "inline"\n\s+self\.send_header\(\n\s+"Content-Disposition",\n\s+f"\{disp\}; filename=\\\"[^"]+\\\"; filename\*=UTF-8\'\'\{quote\(path\.name\)\}",\n\s+\))',
    r'\n        disp = "attachment" if force_attach else "inline"\n        self.send_header("Content-Disposition", content_disposition(disp, path.name))',
    content
)

content = re.sub(
    r'self\.send_header\("Content-Disposition", f"\{disposition\}; filename=\\\"[^"]+\\\"; filename\*=UTF-8\'\'\{quote\(path\.name\)\}"\)',
    r'self.send_header("Content-Disposition", content_disposition(disposition, path.name))',
    content
)

# 3. Cache in hq_snapshot
old_snap = '''def hq_snapshot() -> dict:
    raw_devices = cached_roster_devices()
    devices = hq_devices.normalize_all(raw_devices)
    attention = hq_attention(raw_devices)
    scenes = [
        {"id": s.get("id"), "label": s.get("label")}
        for s in (CONFIG.get("scenes") or [])
        if isinstance(s, dict) and s.get("id")
    ]
    return {
        "ok": True,
        "version": "7.0",
        "state": hq_overall_state(attention),
        "attention": attention,
        "devices": devices,
        "events": hq_events.recent(12),
        "scenes": scenes,
        "generated_at": time.time(),
        "cached": True,
        "roster_age_sec": roster_cache_age(),
        "calendar": _calendar_summary(),
        "agent": hq_companion.summary(),
    }'''

new_snap = '''_HQ_SNAPSHOT_CACHE: "tuple[float, dict] | None" = None
_HQ_SNAPSHOT_CACHE_SEC = 2.0

def hq_snapshot(force: bool = False) -> dict:
    global _HQ_SNAPSHOT_CACHE
    now = time.time()
    if not force and _HQ_SNAPSHOT_CACHE is not None:
        cached_at, cached_payload = _HQ_SNAPSHOT_CACHE
        if now - cached_at < _HQ_SNAPSHOT_CACHE_SEC:
            return dict(cached_payload)
    raw_devices = cached_roster_devices()
    devices = hq_devices.normalize_all(raw_devices)
    attention = hq_attention(raw_devices)
    scenes = [
        {"id": s.get("id"), "label": s.get("label")}
        for s in (CONFIG.get("scenes") or [])
        if isinstance(s, dict) and s.get("id")
    ]
    payload = {
        "ok": True,
        "version": "7.0",
        "state": hq_overall_state(attention),
        "attention": attention,
        "devices": devices,
        "events": hq_events.recent(12),
        "scenes": scenes,
        "generated_at": now,
        "cached": True,
        "roster_age_sec": roster_cache_age(),
        "calendar": _calendar_summary(),
        "agent": hq_companion.summary(),
    }
    _HQ_SNAPSHOT_CACHE = (now, payload)
    return payload'''

if old_snap in content:
    content = content.replace(old_snap, new_snap)

if crlf:
    content = content.replace("\n", "\r\n")

bridge_path.write_text(content, encoding="utf-8")
print("Clean backend patch applied.")
