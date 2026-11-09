from pathlib import Path

# 1. Update ASSET_CONTENT_TYPES in iphone_bridge.py
bridge = Path("iphone_bridge.py")
text = bridge.read_text(encoding="utf-8")
if '".gif": "image/gif"' not in text:
    text = text.replace(
        '".webp": "image/webp",\n',
        '".webp": "image/webp",\n    ".gif": "image/gif",\n'
    )
    text = text.replace(
        '".webp": "image/webp",\r\n',
        '".webp": "image/webp",\r\n    ".gif": "image/gif",\r\n'
    )
    bridge.write_text(text, encoding="utf-8")
    print("ASSET_CONTENT_TYPES updated with .gif")

# 2. Fix test_hq_budget_integrity.py line 139
test_budget = Path("tests/test_hq_budget_integrity.py")
ttext = test_budget.read_text(encoding="utf-8")
old_line = 'row = ai.usage()["token_window"][ai.AMBIENT_CHAIN[0]][0]'
new_line = 'model = result.get("model") or ai.CHAT_CHAIN[0]\n        row = (ai.usage()["token_window"].get(model) or ai.usage()["token_window"].get(ai.AMBIENT_CHAIN[0]))[0]'
if old_line in ttext:
    ttext = ttext.replace(old_line, new_line)
    test_budget.write_text(ttext, encoding="utf-8")
    print("test_hq_budget_integrity.py updated")
