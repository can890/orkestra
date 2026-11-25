package app.orkestra.mobile.mediaproxy;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Uygulamanın önbellek dizininde sabit boyutlu medya blokları için diskte, toplam bayt sınırlı
 * LRU önbellek. Bellekte yalnızca anahtar → uzunluk tablosu tutulur; blok verisi diskte durur.
 * Her açılışta dizin temizlenir (akış kimlikleri ve gizli anahtar açılışa özeldir).
 */
public final class BlockCache {
    private final File dir;
    private final long maxBytes;
    private final LinkedHashMap<String, Long> entries = new LinkedHashMap<>(64, 0.75f, true);
    private long totalBytes = 0;

    public BlockCache(File dir, long maxBytes) {
        this.dir = dir;
        this.maxBytes = Math.max(1, maxBytes);
        deleteChildren(dir);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
    }

    private static void deleteChildren(File dir) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            //noinspection ResultOfMethodCallIgnored
            child.delete();
        }
    }

    static String key(String streamId, long index) {
        return streamId + "_" + index;
    }

    private File fileFor(String key) {
        return new File(dir, key + ".blk");
    }

    public synchronized boolean has(String streamId, long index) {
        return entries.containsKey(key(streamId, index));
    }

    public synchronized long totalBytes() {
        return totalBytes;
    }

    public synchronized int blockCount() {
        return entries.size();
    }

    /** Blok önbellekteyse içeriğini döndürür (LRU sırasını tazeler), yoksa `null`. */
    public byte[] read(String streamId, long index) {
        String key = key(streamId, index);
        Long length;
        synchronized (this) {
            length = entries.get(key);
        }
        if (length == null) return null;
        File file = fileFor(key);
        byte[] data = new byte[(int) (long) length];
        try (FileInputStream in = new FileInputStream(file)) {
            int pos = 0;
            while (pos < data.length) {
                int n = in.read(data, pos, data.length - pos);
                if (n < 0) break;
                pos += n;
            }
            if (pos != data.length) throw new IOException("short block");
            return data;
        } catch (IOException e) {
            // Dosya bu arada tahliye edildiyse kaçırma say.
            synchronized (this) {
                Long removed = entries.remove(key);
                if (removed != null) totalBytes -= removed;
            }
            return null;
        }
    }

    /** Bloğu atomik olarak (geçici dosya + yeniden adlandırma) yazar ve sınırı aşan eski blokları siler. */
    public void put(String streamId, long index, byte[] data) {
        if (data.length > maxBytes) return;
        String key = key(streamId, index);
        File target = fileFor(key);
        File tmp = new File(dir, key + "." + Thread.currentThread().getId() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp, false)) {
            out.write(data);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return;
        }
        synchronized (this) {
            if (!tmp.renameTo(target)) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                return;
            }
            Long previous = entries.put(key, (long) data.length);
            if (previous != null) totalBytes -= previous;
            totalBytes += data.length;
            evict(key);
        }
    }

    private void evict(String keep) {
        Iterator<Map.Entry<String, Long>> it = entries.entrySet().iterator();
        while (totalBytes > maxBytes && it.hasNext()) {
            Map.Entry<String, Long> eldest = it.next();
            if (eldest.getKey().equals(keep)) continue;
            it.remove();
            totalBytes -= eldest.getValue();
            //noinspection ResultOfMethodCallIgnored
            fileFor(eldest.getKey()).delete();
        }
    }

    public synchronized void clear() {
        entries.clear();
        totalBytes = 0;
        deleteChildren(dir);
    }
}
