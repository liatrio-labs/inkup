import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// Static output for GitHub Pages (ADR 0026). The deploy workflow sets SITE_URL and SITE_BASE from where Pages serves
// the site: https://liatrio-labs.github.io under /inkup until the custom domain is live, https://inkup.liatr.io under
// / after. The base ends in a slash, or the sitemap lists the home page twice.
export default defineConfig({
  site: process.env.SITE_URL || 'https://inkup.liatr.io',
  base: (process.env.SITE_BASE || '/').replace(/\/?$/, '/'),
  output: 'static',
  integrations: [sitemap()],
});
