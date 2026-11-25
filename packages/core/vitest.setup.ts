import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ACP oturumları yerleşik alt ajan MCP köprüsünü (`orkestra-subagents-mcp.mjs`)
// `ORKESTRA_STATE_DIR` altına, yoksa `~/.local/state/orkestra/mcp` içine yazar. Testler
// geliştiricinin kurulu uygulamasının kullandığı köprü dosyasının üzerine yazmasın ve
// beklenen köprü yolu makineden bağımsız olsun diye her test işçisi geçici bir dizin kullanır.
if (!process.env.ORKESTRA_STATE_DIR?.trim()) {
  process.env.ORKESTRA_STATE_DIR = mkdtempSync(join(tmpdir(), 'orkestra-core-test-state-'));
}
