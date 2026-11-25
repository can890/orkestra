// Kenar çubuğu sürükle-bırak kimlikleri: proje ağacı ve "Sohbetler" listesi aynı DndContext'i
// paylaştığı için iki yerde de aynı biçim kullanılmalıdır.

export const toProjectDndId = (id: string) => `proj::${id}`;
export const toTaskDndId = (projectId: string, taskId: string) => `task::${projectId}::${taskId}`;

export type SidebarDndId =
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string };

export function parseDndId(id: string): SidebarDndId | null {
  if (id.startsWith('proj::')) return { kind: 'project', projectId: id.slice(6) };
  if (id.startsWith('task::')) {
    const [, projectId, taskId] = id.split('::');
    if (projectId && taskId) return { kind: 'task', projectId, taskId };
  }
  return null;
}
