# JobOS TUI sketches

Throwaway prototypes. **Locked design: [011](011-rich-pipeline-operator-skin/) — see [LOCKED.md](LOCKED.md).**

## Locked

| Path | Description |
|------|-------------|
| **`011-rich-pipeline-operator-skin/`** | **Canonical:** 009 structure × 010 operator style; agent default on; review/log overlays |

Preview: http://100.81.6.117:8765/011-rich-pipeline-operator-skin/

## Archive (do not implement from)

| Path | Notes |
|------|--------|
| 001–003 | Early A/B/C explorations |
| 004 hybrid cockpit | Too much chrome |
| 005 focus hierarchy | Too empty / mobile drill |
| 006–008 picked shells | Structure right idea, too sparse |
| 009 rich pipeline | Structure source for 011 |
| 010 rich operator | Style source for 011 |

Shared scripts: `_rich-shell.js` (011 behavior), `_picked-shell.js` (archive).

```bash
python3 -m http.server 8765 --directory sketches
# http://100.81.6.117:8765/011-rich-pipeline-operator-skin/
```
