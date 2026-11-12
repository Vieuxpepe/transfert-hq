# Musique — Spotify setup (Transfert HQ)

Native **Musique** tab (admin session). Separate from local **Lecteur**.

## Spotify Developer Dashboard

1. Create an app at [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add a **Redirect URI** that matches HQ exactly, for example:
   - Local: `http://127.0.0.1:8765/api/spotify/callback`
   - Tailscale Serve HTTPS: `https://<your-host>/api/spotify/callback`
3. Note: after 2025-11-27, Spotify rejects bare `localhost` aliases and non-HTTPS remote redirects. `http://127.0.0.1` remains valid for local development.
4. Development-mode apps are limited to allowlisted Spotify users until extended quota / review.

## Bridge configuration

In `bridge_config.json` (gitignored) **or** environment:

| Key / env | Required | Notes |
|-----------|----------|--------|
| `spotify_client_id` / `SPOTIFY_CLIENT_ID` | yes | Dashboard client id |
| `spotify_client_secret` / `SPOTIFY_CLIENT_SECRET` | optional | Confidential apps; PKCE works without it |
| `spotify_redirect_uri` / `SPOTIFY_REDIRECT_URI` | recommended | Default `http://127.0.0.1:8765/api/spotify/callback` |

Restart the bridge after changing config (explicit operator step — not done by Git push).

## Scopes requested

`user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`, playlist read/modify (public+private+collaborative), `user-read-email`, `user-read-private`, `user-read-recently-played`, `user-library-read`, `user-top-read`.

## Runtime data

| Path | Contents |
|------|----------|
| `.hq-music/profile.json` | Preferences + feedback (no tokens) |
| `.hq-music/discoveries.json` | Verified discovery candidates |
| `.hq-music/presets.json` | Mixer presets |
| `.hq-music/favorites.json` | Local favorites |
| `.hq-music/spotify_tokens.json` | Access/refresh tokens (server-only) |
| `.hq-music/oauth_pending.json` | Short-lived PKCE verifier |

Apply the same private ACL policy as other HQ state dirs before exposing beyond the owner LAN.

## API limitations (do not invent workarounds)

- Playback control requires a **Premium** account and an available Connect device.
- Public API queue: read + append only — no free reorder/remove.
- `/v1/recommendations` and `/v1/audio-features` are unavailable for new apps (Nov 2024). The Mixer uses weighted playlist pools instead.
- Do not send Spotify catalog/listening data to AI models from this feature.

## Mixer

`hq_music_mixer.py` generates explainable sessions from playlist tracks + weights + repetition rules, then optionally saves a Spotify playlist and starts playback.
