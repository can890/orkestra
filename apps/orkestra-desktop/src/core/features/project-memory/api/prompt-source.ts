/** Konuşmalar dilimine verilen, ilk prompt'a eklenecek hafıza dizini kaynağı. */
export interface ProjectMemoryPromptSource {
  /** Dizin bloğu; proje ayarı kapalıysa ya da kayıt yoksa null. */
  promptContext(projectId: string): Promise<string | null>;
}
