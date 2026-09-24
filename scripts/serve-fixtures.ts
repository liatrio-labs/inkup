// `pnpm fixtures:serve` — serve fixtures/site on the primary and second origins until Ctrl-C.
import { DEFAULT_PRIMARY_PORT, DEFAULT_SECOND_PORT, startFixtureServers } from './fixture-server.ts';

const primary = Number(process.env.FIXTURE_PORT ?? DEFAULT_PRIMARY_PORT);
const second = Number(process.env.FIXTURE_SECOND_PORT ?? DEFAULT_SECOND_PORT);
const servers = await startFixtureServers(primary, second);
console.log(`fixture site: ${servers.primaryOrigin}/pricing.html`);
console.log(`second origin: ${servers.secondOrigin}/second/other.html`);
process.on('SIGINT', () => void servers.close().then(() => process.exit(0)));
