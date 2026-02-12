# Changelog

All notable changes to this project are documented in this file.

## 2.0.0 - 2026-02-12
- Added `SOUL.md` to define assistant personality and response style.
- Updated `server.js` to load `SOUL.md` as system prompt with fallback to `SYSTEM_PROMPT`.
- Updated Docker runtime image to copy `SOUL.md` via `Dockerfile`.
- Bumped project version from `0.1.0` to `2.0.0` in `package.json` and `package-lock.json`.
