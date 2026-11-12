"""Read-only Windows system media session observer, adapted from Else-Static.

Works with whichever Windows media app currently owns the global media session;
this is NOT authenticated Spotify Connect, and is not a remote control.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any


async def read_now_playing() -> dict[str, Any]:
    if os.name != "nt":
        return {"available": False, "reason": "windows_only"}
    try:
        from winsdk.windows.media.control import (  # optional dependency
            GlobalSystemMediaTransportControlsSessionManager as MediaManager,
        )
    except ImportError:
        return {"available": False, "reason": "winsdk_not_installed"}
    try:
        manager = await MediaManager.request_async()
        session = manager.get_current_session()
        if session is None:
            return {"available": True, "playing": False, "track": None}
        media = await session.try_get_media_properties_async()
        source = str(getattr(session, "source_app_user_model_id", "") or "")
        title = str(getattr(media, "title", "") or "")
        artist = str(getattr(media, "artist", "") or "")
        if not title:
            return {"available": True, "playing": False, "track": None, "source": source}
        return {"available": True, "playing": None,
                "track": {"title": title[:160], "artist": artist[:160]}, "source": source}
    except Exception:
        return {"available": False, "reason": "media_session_unavailable"}


def get_now_playing() -> dict[str, Any]:
    """Synchronous adapter for Transfert's threaded HTTP server."""
    try:
        return asyncio.run(read_now_playing())
    except RuntimeError:
        return {"available": False, "reason": "event_loop_in_use"}
