/**
 * Brand — the Remo Code logo lockup rendered in the top-left of the AppShell
 * header. Restored to the header in the UI-regression sweep: PR #115 demoted
 * the logo to a text-only link and left the image only inside the desktop
 * sidebar. The header is the canonical home-link affordance, so the logo
 * image lives here and links to `#/`.
 */
export function Brand() {
  return (
    <a
      href="#/"
      className="flex items-center gap-2 px-3 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      aria-label="Remo Code — home"
    >
      <img src="/logo.png" alt="Remo Code" className="h-8 w-auto" />
    </a>
  );
}

export default Brand;
