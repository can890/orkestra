export const STORE_TABLE = '__orkestra_migrations';

/**
 * STORE_TABLE'ın eski adları. v1.2.6 ve öncesi uygulanan migration'ları `__emdash_migrations`
 * tablosuna yazıyordu; runner bu tabloyu STORE_TABLE'a birleştirip kaldırır.
 */
export const LEGACY_STORE_TABLES: readonly string[] = ['__emdash_migrations'];
