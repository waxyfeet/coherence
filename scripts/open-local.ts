import { launchBrowser } from "../server/security/localLauncher";
import { launcherFailureMessage } from "../server/security/launcherErrors";
launchBrowser(process.argv.includes("--dev")).catch((error: unknown) => {
  // Do not print arbitrary exception bodies, manifest content or authentication material.
  console.error(launcherFailureMessage(error));
  process.exitCode = 1;
});
