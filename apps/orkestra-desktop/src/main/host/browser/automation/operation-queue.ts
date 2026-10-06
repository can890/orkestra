/**
 * Bir sayfanın işlemlerini sırayla çalıştırır: eşzamanlı araç çağrıları birbirinin giriş
 * olaylarının (fare, klavye) arasına giremez. Başarısız bir işlem kuyruğu durdurmaz.
 */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => task());
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
