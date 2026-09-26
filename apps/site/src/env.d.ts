interface ImportMetaEnv {
  // Umami analytics (ADR 0026). No website ID, no script.
  readonly PUBLIC_UMAMI_WEBSITE_ID?: string;
  readonly PUBLIC_UMAMI_SRC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
