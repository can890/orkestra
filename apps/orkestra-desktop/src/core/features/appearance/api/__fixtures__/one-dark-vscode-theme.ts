// VS Code tema fikstürü (JSONC: yorumlar ve sondaki virgüller dahil), One Dark'tan kısaltılmıştır.
export const ONE_DARK_VSCODE_THEME = String.raw`// A trimmed VS Code color theme in JSONC form (comments + trailing commas), modelled on One Dark.
{
  "name": "one-dark-pro",
  "type": "dark",
  "colors": {
    "editor.background": "#282c34",
    "editor.foreground": "#abb2bf",
    "editorWidget.background": "#21252b",
    "focusBorder": "#2a2e36", /* too close to the canvas → skipped */
    "button.background": "#2b2f38",
    "textLink.foreground": "#61afef",
    "editorError.foreground": "#e06c75",
    "editorWarning.foreground": "#d19a66",
    "terminal.ansiGreen": "#98c379",
    "terminal.ansiBlue": "#61afef80",
  },
  "tokenColors": [
    { "scope": ["comment"], "settings": { "foreground": "#5c6370" } },
  ],
}
`;
