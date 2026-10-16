// Vite `?raw` imports of text files (the license notices shown in the About dialog).
declare module '*.md?raw' {
  const text: string;
  export default text;
}
declare module '*LICENSE?raw' {
  const text: string;
  export default text;
}
