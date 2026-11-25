package app.orkestra.mobile.mediaproxy;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.file.Files;
import org.junit.Test;

/** Diskteki LRU blok önbelleği: okuma/yazma, toplam bayt sınırı ve en eski blokların tahliyesi. */
public class BlockCacheTest {
    private static File tempDir() throws Exception {
        return Files.createTempDirectory("sovra-blocks").toFile();
    }

    private static byte[] filled(int len, int value) {
        byte[] b = new byte[len];
        java.util.Arrays.fill(b, (byte) value);
        return b;
    }

    @Test
    public void storesAndReadsBlocks() throws Exception {
        BlockCache cache = new BlockCache(tempDir(), 1000);
        cache.put("s", 0, filled(100, 1));
        assertTrue(cache.has("s", 0));
        assertArrayEquals(filled(100, 1), cache.read("s", 0));
        assertNull(cache.read("s", 1));
        assertEquals(100, cache.totalBytes());
    }

    @Test
    public void evictsLeastRecentlyUsedWhenOverBudget() throws Exception {
        File dir = tempDir();
        BlockCache cache = new BlockCache(dir, 300);
        cache.put("s", 0, filled(100, 0));
        cache.put("s", 1, filled(100, 1));
        cache.put("s", 2, filled(100, 2));
        // 0 yeniden kullanıldı → en eski artık 1.
        cache.read("s", 0);
        cache.put("s", 3, filled(100, 3));
        assertTrue(cache.has("s", 0));
        assertFalse(cache.has("s", 1));
        assertTrue(cache.has("s", 2));
        assertTrue(cache.has("s", 3));
        assertEquals(300, cache.totalBytes());
        assertFalse(new File(dir, "s_1.blk").exists());
        File[] files = dir.listFiles();
        assertEquals(3, files == null ? -1 : files.length);
    }

    @Test
    public void replacingBlockKeepsAccountingExact() throws Exception {
        BlockCache cache = new BlockCache(tempDir(), 1000);
        cache.put("s", 0, filled(100, 1));
        cache.put("s", 0, filled(40, 2));
        assertEquals(40, cache.totalBytes());
        assertArrayEquals(filled(40, 2), cache.read("s", 0));
    }

    @Test
    public void missingFileCountsAsMiss() throws Exception {
        File dir = tempDir();
        BlockCache cache = new BlockCache(dir, 1000);
        cache.put("s", 0, filled(10, 1));
        assertTrue(new File(dir, "s_0.blk").delete());
        assertNull(cache.read("s", 0));
        assertFalse(cache.has("s", 0));
        assertEquals(0, cache.totalBytes());
    }

    @Test
    public void startsEmptyEachLaunch() throws Exception {
        File dir = tempDir();
        BlockCache first = new BlockCache(dir, 1000);
        first.put("s", 0, filled(10, 1));
        BlockCache second = new BlockCache(dir, 1000);
        assertEquals(0, second.blockCount());
        File[] files = dir.listFiles();
        assertEquals(0, files == null ? -1 : files.length);
    }
}
