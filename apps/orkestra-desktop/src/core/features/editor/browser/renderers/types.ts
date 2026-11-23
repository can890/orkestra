/** All possible states a file can be in once opened by the editor. */
export type ManagedFileKind =
  | 'text'
  | 'csv'
  | 'markdown'
  | 'mermaid'
  | 'notebook'
  | 'html'
  | 'svg'
  | 'image'
  | 'pdf'
  | 'font'
  | 'office'
  | 'too-large'
  | 'binary';
