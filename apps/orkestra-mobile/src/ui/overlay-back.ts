/**
 * Tam ekran medya katmanları (görsel büyütme, video oynatıcı) için Android geri tuşu yığını:
 * en üstteki katman geri tuşuyla kapanır, ekran değişmez.
 */
const stack: Array<() => void> = [];

export function pushOverlayBack(close: () => void): () => void {
  stack.push(close);
  return () => {
    const index = stack.lastIndexOf(close);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** Açık katman varsa en üsttekini kapatır ve `true` döner. */
export function closeTopOverlay(): boolean {
  const close = stack.pop();
  if (!close) return false;
  close();
  return true;
}
