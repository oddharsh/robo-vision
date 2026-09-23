// adopt.ts: add a stylesheet as a constructed sheet. A constructed sheet is not
// an inline <style>, so it lands on pages whose CSP refuses inline styles
// (Stripe's did, in the dry run, and accepted this).
export function adopt(css: string): void {
  if (!css) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
