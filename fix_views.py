from pathlib import Path

p = Path("iphone_bridge.py")
s = p.read_text(encoding="utf-8")
s = s.replace("views: ['accueil', 'ops']", "views:['accueil','ops']")
s = s.replace("views: ['accueil', 'fichiers', 'ops']", "views:['accueil','fichiers','ops']")
p.write_text(s, encoding="utf-8")
print("Updated views spacing")
