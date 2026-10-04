"""Read only the approved ElevenLabs grant from the native encrypted keyring."""
import json
import sys
import time
import secretstorage

URL = "https://api.us.elevenlabs.io/v1/mcp"
connection = secretstorage.dbus_init()
matched = []
for item in secretstorage.search_items(connection, {"service": "Codex MCP Credentials"}):
    if not item.get_attributes().get("username", "").startswith("elevenlabs|"):
        continue
    data = json.loads(item.get_secret())
    if data.get("server_name") == "elevenlabs" and data.get("url") == URL:
        matched.append((item, data))
if len(matched) != 1:
    raise RuntimeError("ElevenLabs oturumu bulunamadı. Hesabınızı yeniden bağlayın.")
item, data = matched[0]
if sys.argv[1] == "save":
    tokens = json.load(sys.stdin)
    data["token_response"] = tokens
    data["expires_at"] = int(time.time() * 1000) + int(tokens.get("expires_in", 3600)) * 1000
    item.set_secret(json.dumps(data).encode())
    print("{}")
else:
    print(json.dumps(data))
