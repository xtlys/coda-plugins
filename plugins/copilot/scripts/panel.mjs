// Coda reads one account snapshot per refresh; the CLI owns authentication and contacts GitHub itself.
import { readAccount } from './account.mjs';
import { panel } from './quota.mjs';

try {
  const { auth, quota } = await readAccount();
  console.log(JSON.stringify(panel(auth, quota)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
